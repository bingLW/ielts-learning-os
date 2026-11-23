#!/usr/bin/env node
/**
 * v2.7「规划内核」版本化迁移（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.7.mjs --db /tmp/ielts-v27-drill.db --dry-run
 *   node scripts/migrations/v2.7.mjs --db /tmp/ielts-v27-drill.db --allow-no-backup
 *   node scripts/migrations/v2.7.mjs
 *
 * 约束（与 v2.2–v2.6 同源）：
 * 1. 只做加法：新建 5 张规划域表（PlanningSnapshot / SkillGap / TaskCandidate /
 *    TaskPriorityDecision / StageReadinessReview）；既有表仅
 *    PlanTask(+2)、PlanVersion(+5)、LearningCycle(+3) 追加可空列 + 3 个索引。
 *    不删列、不改列类型与语义、不删行。
 * 2. 幂等：CREATE TABLE / CREATE INDEX IF NOT EXISTS；ADD COLUMN 先读 PRAGMA table_info；
 *    同版本不同 checksum 拒绝执行（防脚本被悄悄改动）。
 * 3. 事务：DDL + 版本登记同一事务（BEGIN IMMEDIATE）；失败回滚。
 * 4. 前后核对：受保护表行数、被改造表的「旧列一个不少 + 新列都在」、
 *    integrity_check、foreign_key_check；报告写入 backups/migrations/。
 * 5. 回滚：bash scripts/restore.sh <备份>。v2.7 为纯加法，回滚 = 恢复备份；
 *    单独 DROP 新表会丢快照/决策（"为什么这样排"的证据），不建议。
 *
 * DDL 来源：与 prisma/schema.prisma 经 `prisma db push` 在副本库上生成的结构一致
 * （含外键约束名与列默认值）；ALTER 的列顺序按 Prisma 的字母序排列，
 * 因此迁移后 `prisma db push` 是零变更，不会重建既有的 PlanTask / PlanVersion /
 * LearningCycle（这三张表带数据，重建是最不希望发生的事）。
 *
 * 依赖：仅 /usr/bin/sqlite3。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.7';
const PREVIOUS_VERSIONS = ['v2.6'];
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

/** 按依赖顺序排列（父表先建；SQLite 允许前向引用外键，但保持顺序更易审阅）。 */
const NEW_TABLES = [
  'PlanningSnapshot',
  'SkillGap',
  'TaskCandidate',
  'TaskPriorityDecision',
  'StageReadinessReview',
];

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "PlanningSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purpose" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v2.7.0',
    "budgetJson" TEXT NOT NULL,
    "profileJson" TEXT,
    "workloadJson" TEXT,
    "candidatesJson" TEXT,
    "configJson" TEXT NOT NULL,
    "validationJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS "SkillGap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "dimensionKind" TEXT NOT NULL DEFAULT 'OFFICIAL',
    "skill" TEXT NOT NULL,
    "subskill" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "independentCount" INTEGER NOT NULL DEFAULT 0,
    "freshnessDays" INTEGER,
    "coverageRatio" REAL,
    "severity" REAL NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "evidenceIdsJson" TEXT,
    "missingEvidenceJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillGap_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PlanningSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "TaskCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT,
    "candidateKey" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "targetSkill" TEXT NOT NULL,
    "skillGapId" TEXT,
    "title" TEXT NOT NULL,
    "estMinutes" INTEGER NOT NULL,
    "minMinutes" INTEGER NOT NULL DEFAULT 5,
    "maxBlockMinutes" INTEGER,
    "prerequisitesJson" TEXT,
    "validationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "difficultyScore" REAL,
    "isAiSuggested" BOOLEAN NOT NULL DEFAULT false,
    "aiCallLogId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskCandidate_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PlanningSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskCandidate_skillGapId_fkey" FOREIGN KEY ("skillGapId") REFERENCES "SkillGap" ("id") ON DELETE SET NULL ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "TaskPriorityDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "skillGapId" TEXT,
    "weightsVersion" TEXT NOT NULL DEFAULT 'v1',
    "factorsJson" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "priority" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "consequenceIfSkipped" TEXT,
    "eligibility" TEXT NOT NULL DEFAULT 'ELIGIBLE',
    "blockedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskPriorityDecision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "TaskCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskPriorityDecision_skillGapId_fkey" FOREIGN KEY ("skillGapId") REFERENCES "SkillGap" ("id") ON DELETE SET NULL ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "StageReadinessReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v2.7.0',
    "outcome" TEXT NOT NULL,
    "criteriaJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT,
    "unmetJson" TEXT,
    "userConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" DATETIME,
    "confirmedBy" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StageReadinessReview_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PlanningSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
];

/** 新表的索引（含唯一索引）；名称与 Prisma 生成的一致。 */
const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "PlanningSnapshot_asOfDate_idx" ON "PlanningSnapshot"("asOfDate");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PlanningSnapshot_purpose_asOfDate_inputHash_key" ON "PlanningSnapshot"("purpose", "asOfDate", "inputHash");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SkillGap_snapshotId_skill_subskill_key" ON "SkillGap"("snapshotId", "skill", "subskill");`,
  `CREATE INDEX IF NOT EXISTS "SkillGap_skill_kind_status_idx" ON "SkillGap"("skill", "kind", "status");`,
  `CREATE INDEX IF NOT EXISTS "SkillGap_dimensionKind_idx" ON "SkillGap"("dimensionKind");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TaskCandidate_snapshotId_candidateKey_key" ON "TaskCandidate"("snapshotId", "candidateKey");`,
  `CREATE INDEX IF NOT EXISTS "TaskCandidate_snapshotId_sourceKind_idx" ON "TaskCandidate"("snapshotId", "sourceKind");`,
  `CREATE INDEX IF NOT EXISTS "TaskCandidate_targetSkill_status_idx" ON "TaskCandidate"("targetSkill", "status");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TaskPriorityDecision_candidateId_key" ON "TaskPriorityDecision"("candidateId");`,
  `CREATE INDEX IF NOT EXISTS "TaskPriorityDecision_snapshotId_priority_idx" ON "TaskPriorityDecision"("snapshotId", "priority");`,
  `CREATE INDEX IF NOT EXISTS "StageReadinessReview_stageId_createdAt_idx" ON "StageReadinessReview"("stageId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "StageReadinessReview_outcome_idx" ON "StageReadinessReview"("outcome");`,
];

/**
 * 既有表的纯加法改造（10 个可空列）。
 *
 * 列顺序按 **Prisma 的字母序**：`prisma db push` 追加列时就是按字母序 ALTER 的，
 * 顺序一致才能保证迁移之后 `db push` 判定"零变更"（否则它可能重建表，
 * 而 PlanTask / PlanVersion / LearningCycle 都是带数据的老表）。
 *
 * SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，执行前先用 PRAGMA table_info 判断；
 * checksum 始终基于这份「规范语句清单」，与库里当前是否需要执行无关。
 */
const ALTER_TARGETS = [
  {
    table: 'LearningCycle',
    columns: [
      { name: 'phaseChangedAt', type: 'DATETIME' },
      { name: 'primaryTheme', type: 'TEXT' },
      { name: 'secondaryThemesJson', type: 'TEXT' },
    ],
  },
  {
    table: 'PlanTask',
    columns: [
      { name: 'candidateId', type: 'TEXT' },
      { name: 'decisionJson', type: 'TEXT' },
    ],
  },
  {
    table: 'PlanVersion',
    columns: [
      { name: 'layer', type: 'TEXT' },
      { name: 'parentVersionId', type: 'TEXT' },
      { name: 'snapshotId', type: 'TEXT' },
      { name: 'staleAt', type: 'DATETIME' },
      { name: 'staleReason', type: 'TEXT' },
    ],
  },
];

const ALTER_STATEMENTS = ALTER_TARGETS.flatMap((target) =>
  target.columns.map(
    (column) => `ALTER TABLE "${target.table}" ADD COLUMN "${column.name}" ${column.type};`,
  ),
);

/** 被改造表上的新索引（与 schema 的 @@index 一致）。 */
const ALTERED_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "PlanTask_candidateId_idx" ON "PlanTask"("candidateId");`,
  `CREATE INDEX IF NOT EXISTS "PlanVersion_snapshotId_idx" ON "PlanVersion"("snapshotId");`,
];

/**
 * 受保护表：行数必须零漂移。
 *
 * 在 v2.6 的清单基础上新增 `PlanVersion` 与 `LearningCycle`（`PlanTask` 原本就在）——
 * 这三张表是本版唯一被 ALTER 的老表，行数一变就说明 ALTER 写成了重建表（SQLite 的
 * 12 步改表流程会临时搬数据）。列层面的核对另见 `columnDrift`。
 */
const PROTECTED_TABLES = [
  'PlanTask',
  'PlanVersion',
  'LearningCycle',
  'StudySession',
  'StudyRecord',
  'Mistake',
  'ReviewTask',
  'EvidenceRecord',
  'RetestSchedule',
  'VocabularyItem',
  'VocabularyItemSource',
  'VocabularySource',
  'VocabularyPracticeSession',
  'AIEngineSetting',
  'AIModelConfig',
  'DiagnosticSession',
  'DiagnosticAttempt',
  'AIProviderCredential',
  'AICallLog',
];

/** 允许「只增不减」的表（迁移期间应用仍在跑时会新增日志行）。 */
const GROW_ONLY_TABLES = ['AICallLog'];

const CORE_TABLES = [
  'UserProfile',
  'Stage',
  'PlanTask',
  'PlanVersion',
  'LearningCycle',
  'StudySession',
  'StudyRecord',
  'Mistake',
  'ReviewTask',
  'EvidenceRecord',
  'SkillProfile',
  'RetestSchedule',
  'VocabularyItem',
  'PromptVersion',
  'AILearningSession',
  'AIEngineSetting',
  'AIModelConfig',
  'DiagnosticSession',
  'DiagnosticAttempt',
  'AppMigration',
  'AICallLog',
];

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, dryRun: false, allowNoBackup: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      opts.db = argv[++i];
      if (!opts.db) throw new Error('--db 需要一个路径');
    } else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-no-backup') opts.allowNoBackup = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  opts.db = path.resolve(opts.db);
  return opts;
}

function log(opts, message) {
  if (!opts.quiet) console.log(message);
}

function runSql(db, sql) {
  return execFileSync(SQLITE3, ['-batch', '-bail', db], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function query(db, sql) {
  return execFileSync(SQLITE3, ['-batch', '-noheader', '-list', db], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function tableExists(db, name) {
  return query(db, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${name}';`) === '1';
}

function tableColumns(db, name) {
  const rows = query(db, `PRAGMA table_info("${name}");`);
  if (!rows) return new Set();
  // PRAGMA table_info 的列：cid|name|type|notnull|dflt_value|pk
  return new Set(rows.split('\n').map((line) => line.split('|')[1]));
}

function countTable(db, name) {
  if (!tableExists(db, name)) return null;
  return Number(query(db, `SELECT count(*) FROM "${name}";`));
}

function snapshotCounts(db, tables) {
  const out = {};
  for (const table of tables) out[table] = countTable(db, table);
  return out;
}

/** 行数漂移：普通受保护表必须完全相等；GROW_ONLY_TABLES 只要求不减。 */
function checkDrift(table, before, after) {
  if (before === null || after === null) return before === after ? null : `${table}: ${before} → ${after}`;
  if (GROW_ONLY_TABLES.includes(table)) return after >= before ? null : `${table}: ${before} → ${after}（不允许减少）`;
  return before === after ? null : `${table}: ${before} → ${after}`;
}

/**
 * 列层面核对：**旧列一个不少 + 新列都在**。
 *
 * 只有行数不变是不够的：如果有人把 ALTER 改成"重建表"，行数照样不变，
 * 但可能漏掉某个旧列。这里逐列比对列名集合，把这种最危险的偏差变成硬失败。
 *
 * @returns 漂移说明数组（空数组 = 通过）
 */
function columnDrift(beforeColumns, afterColumns) {
  const problems = [];
  for (const [table, columns] of beforeColumns) {
    const after = afterColumns.get(table) ?? new Set();
    for (const column of columns) {
      if (!after.has(column)) problems.push(`${table}.${column} 在迁移后消失`);
    }
  }
  for (const target of ALTER_TARGETS) {
    const after = afterColumns.get(target.table) ?? new Set();
    for (const column of target.columns) {
      if (!after.has(column.name)) problems.push(`${target.table}.${column.name} 没有建出来`);
    }
  }
  return problems;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法：node scripts/migrations/v2.7.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

  --db <路径>        目标数据库（默认 prisma/dev.db）
  --dry-run          只打印将执行的语句，不写库
  --allow-no-backup  跳过「必须已有当日备份」检查（仅用于副本演练）
`);
    return;
  }

  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`);

  if (!tableExists(opts.db, 'AppMigration')) {
    throw new Error('缺少 AppMigration 表：请先完成 v2.4 及后续迁移');
  }
  for (const previous of PREVIOUS_VERSIONS) {
    const registered = query(opts.db, `SELECT count(*) FROM "AppMigration" WHERE version='${previous}';`) === '1';
    if (!registered) throw new Error(`尚未登记 ${previous}：请先运行 scripts/migrations/${previous}.mjs`);
  }

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    // 「当日备份」：文件名形如 dev-YYYYMMDD-*.db（scripts/backup.sh 的命名）
    const today = new Date();
    const pad = (value) => (value < 10 ? `0${value}` : String(value));
    const stamp = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : [];
    const hasTodayBackup = files.some(
      (name) => new RegExp(`^dev-${stamp}(-\\d+)?\\.db$`).test(name),
    );
    if (!hasTodayBackup) {
      throw new Error(
        `升级真实库前必须先做当日备份：bash scripts/backup.sh（期望 backups/dev-${stamp}-*.db）`,
      );
    }
  }

  const checksum = createHash('sha256')
    .update(
      CREATE_TABLES.join('\n--\n')
        + '===\n'
        + ALTER_STATEMENTS.join('\n')
        + '===\n'
        + [...CREATE_INDEXES, ...ALTERED_INDEXES].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);

  let alreadyApplied = false;
  const registeredChecksum = query(
    opts.db,
    `SELECT checksum FROM "AppMigration" WHERE version='${VERSION}' LIMIT 1;`,
  );
  if (registeredChecksum) {
    if (registeredChecksum !== checksum) {
      throw new Error(
        `版本 ${VERSION} 已登记但校验和不一致（库=${registeredChecksum}，脚本=${checksum}）。请确认脚本来源，禁止直接重跑覆盖。`,
      );
    }
    alreadyApplied = true;
  } else if (tableExists(opts.db, 'PlanningSnapshot')) {
    // 已存在新表但未登记 v2.7：说明库被别的方式改过（例如直接 db push），禁止盲跑
    throw new Error('检测到 PlanningSnapshot 表已存在但 AppMigration 无 v2.7 记录：请先核对库结构来源');
  }

  const columnsBefore = new Map();
  const pendingAlterColumns = [];
  for (const target of ALTER_TARGETS) {
    const existing = tableColumns(opts.db, target.table);
    if (!existing.size) throw new Error(`缺少 ${target.table} 表：库结构异常`);
    columnsBefore.set(target.table, existing);
    for (const column of target.columns) {
      if (!existing.has(column.name)) {
        pendingAlterColumns.push({ table: target.table, ...column });
      }
    }
  }

  const before = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);

  const allIndexes = [...CREATE_INDEXES, ...ALTERED_INDEXES];
  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    // CREATE_TABLES 的多行 DDL 不带分号（与 prisma 生成物一致），这里统一补终止符
    ...CREATE_TABLES.map((sql) => `${sql};`),
    ...pendingAlterColumns.map(
      (column) => `ALTER TABLE "${column.table}" ADD COLUMN "${column.name}" ${column.type};`,
    ),
    ...allIndexes,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.7','${VERSION}','${checksum}','纯加法：规划内核 5 表 + PlanTask/PlanVersion/LearningCycle 10 可空列') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.7 迁移预演（dry-run）==\n数据库：${opts.db}`);
    log(opts, `版本：${VERSION}　校验和：${checksum}　已登记：${alreadyApplied ? '是' : '否'}`);
    log(opts, `将新建表：${NEW_TABLES.length} 张 → ${NEW_TABLES.join(', ')}`);
    log(opts, `将新建索引：${allIndexes.length} 个（新表 ${CREATE_INDEXES.length} + 老表 ${ALTERED_INDEXES.length}）`);
    log(
      opts,
      `将新增列：${pendingAlterColumns.length ? pendingAlterColumns.map((c) => `${c.table}.${c.name} ${c.type}`).join(', ') : '（10 列均已存在）'}`,
    );
    log(opts, '--- 事务 SQL ---');
    log(opts, transactionSql);
    return;
  }

  const startedAt = Date.now();
  try {
    runSql(opts.db, transactionSql);
  } catch (error) {
    throw new Error(`迁移失败，未提交（已回滚）：${error.stderr || error.message}`);
  }
  const durationMs = Date.now() - startedAt;

  const integrity = query(opts.db, 'PRAGMA integrity_check;');
  const fkRows = query(opts.db, 'PRAGMA foreign_key_check;');
  const after = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);

  const missingTables = NEW_TABLES.filter((name) => !tableExists(opts.db, name));
  const missingIndexes = allIndexes
    .map((sql) => /"([^"]+_idx|[^"]+_key)"/.exec(sql)?.[1])
    .filter(
      (name) =>
        !name || query(opts.db, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='${name}';`) !== '1',
    );
  const columnsAfter = new Map(ALTER_TARGETS.map((target) => [target.table, tableColumns(opts.db, target.table)]));
  const columnProblems = columnDrift(columnsBefore, columnsAfter);
  const missingColumns = columnProblems.filter((item) => item.includes('没有建出来'));

  const protectedDrift = PROTECTED_TABLES.map((table) => checkDrift(table, before[table], after[table])).filter(
    (item) => item !== null,
  );

  const ok =
    integrity === 'ok' &&
    fkRows === '' &&
    missingTables.length === 0 &&
    missingIndexes.length === 0 &&
    missingColumns.length === 0 &&
    columnProblems.length === 0 &&
    protectedDrift.length === 0;

  const report = {
    version: VERSION,
    database: opts.db,
    checksum,
    alreadyApplied,
    appliedAt: new Date().toISOString(),
    durationMs,
    integrity,
    foreignKeyViolations: fkRows ? fkRows.split('\n').length : 0,
    newTables: NEW_TABLES,
    newIndexes: allIndexes.length,
    alteredColumns: pendingAlterColumns.map((column) => `${column.table}.${column.name} ${column.type}`),
    expectedAlteredColumns: ALTER_TARGETS.flatMap((target) =>
      target.columns.map((column) => `${target.table}.${column.name} ${column.type}`),
    ),
    missingTables,
    missingIndexes,
    missingColumns,
    columnProblems,
    before,
    after,
    protectedDrift,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.7-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.7 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增表：${NEW_TABLES.length} 张（缺失 ${missingTables.length}）　新增索引：${allIndexes.length} 个（缺失 ${missingIndexes.length}）`);
  log(opts, `新增列：${report.alteredColumns.length} 个${report.alteredColumns.length ? ` → ${report.alteredColumns.join(', ')}` : '（均已存在）'}`);
  log(opts, `列核对问题：${columnProblems.length}${columnProblems.length ? ` → ${columnProblems.join('; ')}` : ''}`);
  log(opts, `受保护表行数漂移：${protectedDrift.length}${protectedDrift.length ? ` → ${protectedDrift.join('; ')}` : ''}`);
  log(opts, `报告：${path.relative(ROOT, reportPath)}`);

  if (!ok) {
    console.error('校验未通过，请用备份回滚：bash scripts/restore.sh <backup>');
    process.exitCode = 1;
  }
}

main();
