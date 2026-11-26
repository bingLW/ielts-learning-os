#!/usr/bin/env node
/**
 * v2.7.1 P0-6 音频/语音 tombstone + AI 预算预占迁移（纯加法、幂等）。
 *
 * 只允许显式隔离库（/tmp 或 /private/tmp），绝不默认指向 prisma/dev.db：
 *   DATABASE_URL=file:/tmp/ielts-v271.db node scripts/migrations/v2.7.1.mjs --dry-run
 *   DATABASE_URL=file:/tmp/ielts-v271.db node scripts/migrations/v2.7.1.mjs
 *
 * 新增 AudioAsset/RecordingAsset.deletedAt + deletionReason（均可空）及 deletedAt 索引；
 * 追加 AIEngineSetting.budgetReservedUsd REAL NOT NULL DEFAULT 0（进行中的外发预占）。
 * 不重建表、不删行/列、不改外键。执行前自动 .backup 并校验；执行后核对 integrity_check、
 * foreign_key_check、全部用户表行数、旧列保留和 AppMigration checksum。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.7.1';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIVE_DB = path.join(ROOT, 'prisma', 'dev.db');
const TARGETS = [
  { table: 'AudioAsset', columns: [['deletedAt', 'DATETIME'], ['deletionReason', 'TEXT']] },
  { table: 'RecordingAsset', columns: [['deletedAt', 'DATETIME'], ['deletionReason', 'TEXT']] },
  { table: 'AIEngineSetting', columns: [['budgetReservedUsd', 'REAL NOT NULL DEFAULT 0']] },
  { table: 'SpeakingPrompt', columns: [['active', 'BOOLEAN NOT NULL DEFAULT true']] },
  { table: 'AssessmentResult', columns: [['aiCallLogId', 'TEXT'], ['aiModelId', 'TEXT'], ['aiPromptVersionId', 'TEXT']] },
];
const ALTER_STATEMENTS = TARGETS.flatMap(({ table, columns }) =>
  columns.map(([name, type]) => `ALTER TABLE "${table}" ADD COLUMN "${name}" ${type};`),
);
const INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS "AudioAsset_deletedAt_idx" ON "AudioAsset"("deletedAt");',
  'CREATE INDEX IF NOT EXISTS "RecordingAsset_deletedAt_idx" ON "RecordingAsset"("deletedAt");',
];
const STATEMENTS = [...ALTER_STATEMENTS, ...INDEX_STATEMENTS];
const CHECKSUM = createHash('sha256').update(STATEMENTS.join('\n')).digest('hex');
const INDEXES = ['AudioAsset_deletedAt_idx', 'RecordingAsset_deletedAt_idx'];

function usage() {
  console.log(`用法：DATABASE_URL=file:/tmp/example.db node scripts/migrations/v2.7.1.mjs [--db /tmp/example.db] [--dry-run]
       node scripts/migrations/v2.7.1.mjs --checksum-only
--checksum-only 只输出权威 checksum，不读/写数据库。
仅允许 /tmp 或 /private/tmp 下的隔离数据库；真实 prisma/dev.db 永远拒绝。`);
}

function parseArgs(argv) {
  let db = null;
  let dryRun = false;
  let checksumOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--db') {
      db = argv[++index];
      if (!db) throw new Error('--db 需要一个路径');
    } else if (argv[index] === '--dry-run') dryRun = true;
    else if (argv[index] === '--checksum-only') checksumOnly = true;
    else if (['-h', '--help'].includes(argv[index])) return { help: true };
    else throw new Error(`未知参数：${argv[index]}`);
  }
  if (checksumOnly) return { db: null, dryRun: false, checksumOnly: true, help: false };
  const databaseUrl = process.env.DATABASE_URL;
  if (db && databaseUrl && databaseUrl !== `file:${path.resolve(db)}` && !databaseUrl.startsWith(`file:${path.resolve(db)}?`)) {
    throw new Error('--db 与 DATABASE_URL 不一致，拒绝猜测目标');
  }
  if (!db && databaseUrl) {
    if (!databaseUrl.startsWith('file:')) throw new Error('DATABASE_URL 必须是 SQLite file: URL');
    db = databaseUrl.slice(5).split('?', 1)[0];
  }
  if (!db) throw new Error('必须显式提供 --db /tmp/... 或 DATABASE_URL=file:/tmp/...');
  return { db: path.resolve(db), dryRun, help: false };
}

function sql(db, text, list = false) {
  return execFileSync(SQLITE3, ['-batch', '-bail', '-noheader', ...(list ? ['-list'] : []), db], {
    input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function tables(db) {
  const output = sql(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;", true);
  return output ? output.split('\n') : [];
}

function columnRows(db, table) {
  const output = sql(db, `PRAGMA table_info("${table}");`, true);
  return output ? output.split('\n').map((row) => {
    const [cid, name, type, notNull, defaultValue, primaryKey] = row.split('|');
    return { cid: Number(cid), name, type: type.toUpperCase(), notNull: Number(notNull), defaultValue, primaryKey: Number(primaryKey) };
  }) : [];
}

function columns(db, table) {
  return new Set(columnRows(db, table).map((column) => column.name));
}

function counts(db, names) {
  return Object.fromEntries(names.map((table) => [table, Number(sql(db, `SELECT count(*) FROM "${table}";`))]));
}

function assertIsolated(db) {
  const parent = path.dirname(db);
  if (!existsSync(parent)) throw new Error('隔离数据库父目录不存在');
  const realParent = realpathSync(parent);
  const realTarget = existsSync(db) ? realpathSync(db) : path.join(realParent, path.basename(db));
  const temporaryRoots = new Set(['/tmp', os.tmpdir()].map((directory) => realpathSync(directory)));
  if (![...temporaryRoots].some((temporaryRoot) => realTarget === temporaryRoot || realTarget.startsWith(temporaryRoot + path.sep))) {
    throw new Error('安全阻断：迁移只允许系统临时目录下的显式隔离数据库');
  }
  if (existsSync(db) && path.resolve(db) === path.resolve(LIVE_DB)) throw new Error('安全阻断：禁止迁移真实 prisma/dev.db');
  if (!existsSync(db)) throw new Error('隔离数据库不存在；请先创建隔离空库/基线库');
  return realTarget;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (options.checksumOnly) {
    console.log(CHECKSUM);
    return;
  }
  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  const db = assertIsolated(options.db);
  if (!tables(db).includes('AppMigration')) throw new Error('缺少 AppMigration，请先完成 v2.7 基线迁移');
  for (const table of ['AudioAsset', 'RecordingAsset', 'AIEngineSetting', 'SpeakingPrompt', 'AssessmentResult']) {
    if (!tables(db).includes(table)) throw new Error(`缺少 ${table}，请先完成 v2.5 语音域迁移`);
  }
  const prior = sql(db, "SELECT count(*) FROM AppMigration WHERE version='v2.7';");
  if (prior !== '1') throw new Error('尚未登记 v2.7，请先完成基线迁移');
  const registered = sql(db, `SELECT checksum FROM AppMigration WHERE version='${VERSION}' LIMIT 1;`);
  if (registered && registered !== CHECKSUM) throw new Error(`AppMigration checksum 不一致：库=${registered}，脚本=${CHECKSUM}`);

  const names = tables(db);
  const beforeCounts = counts(db, names);
  const beforeColumns = Object.fromEntries(TARGETS.map(({ table }) => [table, columns(db, table)]));
  const beforeDefinitions = Object.fromEntries(TARGETS.map(({ table }) => [table, columnRows(db, table)]));
  const expectedDefinitions = {
    deletedAt: { type: 'DATETIME', notNull: 0, defaultValue: '' },
    deletionReason: { type: 'TEXT', notNull: 0, defaultValue: '' },
    budgetReservedUsd: { type: 'REAL', notNull: 1, defaultValue: '0' },
    active: { type: 'BOOLEAN', notNull: 1, defaultValue: 'true' },
    aiCallLogId: { type: 'TEXT', notNull: 0, defaultValue: '' },
    aiModelId: { type: 'TEXT', notNull: 0, defaultValue: '' },
    aiPromptVersionId: { type: 'TEXT', notNull: 0, defaultValue: '' },
  };
  for (const { table, columns: expected } of TARGETS) {
    for (const [name] of expected) {
      if (!beforeColumns[table].has(name)) continue;
      const actual = beforeDefinitions[table].find((column) => column.name === name);
      const wanted = expectedDefinitions[name];
      if (!actual || actual.type !== wanted.type || actual.notNull !== wanted.notNull || actual.defaultValue !== wanted.defaultValue) {
        throw new Error(`${table}.${name} 已存在但类型/可空性/默认值定义不正确，拒绝继续迁移`);
      }
    }
  }
  const pendingAlters = TARGETS.flatMap(({ table, columns: expected }) =>
    expected
      .filter(([name]) => !beforeColumns[table].has(name))
      .map(([name, type]) => `ALTER TABLE "${table}" ADD COLUMN "${name}" ${type};`),
  );
  const pending = [...pendingAlters, ...INDEX_STATEMENTS];
  const integrityBefore = sql(db, 'PRAGMA integrity_check;');
  const fkBefore = sql(db, 'PRAGMA foreign_key_check;');
  if (integrityBefore !== 'ok' || fkBefore) throw new Error('迁移前完整性或外键检查失败');

  if (options.dryRun) {
    console.log(JSON.stringify({ version: VERSION, database: db, checksum: CHECKSUM, alreadyRegistered: Boolean(registered), pendingStatements: pending, beforeCounts }, null, 2));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(db), `${path.basename(db)}.pre-${VERSION}-${stamp}.db`);
  execFileSync(SQLITE3, ['-batch', '-bail', db], { input: `.backup ${quote(backup)}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  const backupIntegrity = sql(backup, 'PRAGMA integrity_check;');
  const backupForeignKeys = sql(backup, 'PRAGMA foreign_key_check;');
  const backupCounts = counts(backup, names);
  const backupRowDrift = names.filter((table) => beforeCounts[table] !== backupCounts[table]);
  if (backupIntegrity !== 'ok' || backupForeignKeys || backupRowDrift.length) {
    throw new Error('自动备份完整性、外键或行数校验失败，未执行迁移');
  }

  const transaction = [
    'PRAGMA foreign_keys=ON;', 'BEGIN IMMEDIATE;', ...pending,
    `INSERT INTO AppMigration(id,version,checksum,note) VALUES('appmig-v2.7.1','${VERSION}','${CHECKSUM}','P0-6 音频/语音 tombstone + AI 预算预占 + P0-4 诊断 AI 审计 + P1-2 SpeakingPrompt.active：9 个纯加法列 + 2 个索引，不删历史') ON CONFLICT(version) DO NOTHING;`,
    'COMMIT;',
  ].join('\n');
  try {
    sql(db, transaction);
  } catch (error) {
    throw new Error(`迁移事务失败并回滚：${error.stderr || error.message}`);
  }

  const afterCounts = counts(db, names);
  // AppMigration 是迁移注册表，本次允许且应当新增一行；其他所有用户表行数必须保持不变。
  const rowDrift = names.filter((table) => table !== 'AppMigration' && beforeCounts[table] !== afterCounts[table])
    .map((table) => `${table}: ${beforeCounts[table]} → ${afterCounts[table]}`);
  const columnProblems = [];
  for (const { table, columns: expected } of TARGETS) {
    const actualRows = columnRows(db, table);
    const actual = new Set(actualRows.map((column) => column.name));
    for (const oldColumn of beforeDefinitions[table]) {
      const preserved = actualRows.find((column) => column.name === oldColumn.name);
      if (!preserved || JSON.stringify(preserved) !== JSON.stringify(oldColumn)) columnProblems.push(`${table}.${oldColumn.name} 定义变化或丢失`);
    }
    for (const [name] of expected) {
      if (!actual.has(name)) columnProblems.push(`${table}.${name} 缺失`);
      const definition = actualRows.find((column) => column.name === name);
      const wanted = expectedDefinitions[name];
      if (definition && (definition.type !== wanted.type || definition.notNull !== wanted.notNull || definition.defaultValue !== wanted.defaultValue)) {
        columnProblems.push(`${table}.${name} 定义不正确`);
      }
    }
  }
  const missingIndexes = INDEXES.filter((name) => sql(db, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='${name}';`) !== '1');
  const integrity = sql(db, 'PRAGMA integrity_check;');
  const foreignKeys = sql(db, 'PRAGMA foreign_key_check;');
  const registry = sql(db, `SELECT checksum FROM AppMigration WHERE version='${VERSION}';`);
  const ok = integrity === 'ok' && !foreignKeys && !rowDrift.length && !columnProblems.length && !missingIndexes.length && registry === CHECKSUM;
  const report = {
    version: VERSION, database: db, checksum: CHECKSUM, backup, backupIntegrity, backupForeignKeyViolations: backupForeignKeys ? backupForeignKeys.split('\n').length : 0, backupRowDrift, ok,
    appliedStatements: pending, integrity, foreignKeyViolations: foreignKeys ? foreignKeys.split('\n').length : 0,
    rowDrift, columnProblems, missingIndexes, beforeCounts, afterCounts,
  };
  const reportPath = path.join(path.dirname(db), `${path.basename(db)}.${VERSION}-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, beforeCounts: undefined, afterCounts: undefined, reportPath }, null, 2));
  if (!ok) throw new Error('迁移后校验失败；可用自动备份恢复隔离库');
}

try {
  main();
} catch (error) {
  console.error(`v2.7.1 迁移失败：${error.message}`);
  process.exitCode = 1;
}
