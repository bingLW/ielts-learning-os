#!/usr/bin/env node
/**
 * v2.5「Listening & Speaking Lab」版本化迁移（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.5.mjs --db /tmp/ielts-v25-drill.db --allow-no-backup
 *   node scripts/migrations/v2.5.mjs --dry-run
 *   node scripts/migrations/v2.5.mjs
 *
 * 约束（与 v2.2 / v2.3 / v2.4 / v2.4.1 / v2.4.2 同源）：
 * 1. 只做加法：新建 13 张听说域表；不改既有列、不删行。
 * 2. 幂等：CREATE TABLE IF NOT EXISTS；同版本不同 checksum 拒绝执行。
 * 3. 事务：DDL 与版本登记同一事务；失败回滚。
 * 4. 前后核对：核心/受保护表行数、integrity_check、foreign_key_check；报告写入 backups/migrations/。
 * 5. 回滚：bash scripts/restore.sh <备份>。
 *
 * 依赖：仅 /usr/bin/sqlite3。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.5';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "AudioAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "sourceUrl" TEXT,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "durationSec" INTEGER,
    "language" TEXT,
    "dialectTag" TEXT,
    "rightsInfo" TEXT,
    "permissionState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "Transcript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audioAssetId" TEXT,
    "recordingAssetId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MACHINE',
    "parentTranscriptId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "language" TEXT,
    "confidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "TranscriptSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "text" TEXT NOT NULL,
    "speaker" TEXT,
    "confidence" TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS "ListeningExercise" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audioAssetId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "promptJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "ListeningAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exerciseId" TEXT NOT NULL,
    "evidenceId" TEXT,
    "firstListenResultJson" TEXT,
    "assistedResultJson" TEXT,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "ListeningError" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "errorType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "note" TEXT,
    "isTechnical" BOOLEAN NOT NULL DEFAULT false,
    "userCorrected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "SpeakingPrompt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "rubricVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "SpeakingSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promptId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'PRACTICE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "SpeakingTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT,
    "recordingAssetId" TEXT,
    "transcriptId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "RecordingAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "durationSec" INTEGER,
    "takeNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "ASRResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordingAssetId" TEXT NOT NULL,
    "transcriptId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "confidence" TEXT,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "costUsd" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "SpeechEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "recordingAssetId" TEXT,
    "rubricVersion" TEXT NOT NULL,
    "dimensionsJson" TEXT NOT NULL,
    "evidenceJson" TEXT,
    "limitationsJson" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "needsFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "assessorType" TEXT NOT NULL DEFAULT 'AI',
    "isOfficialScore" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "AudioTechnicalCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordingAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
];

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "AudioAsset_source_idx" ON "AudioAsset"("source");`,
  `CREATE INDEX IF NOT EXISTS "AudioAsset_sha256_idx" ON "AudioAsset"("sha256");`,
  `CREATE INDEX IF NOT EXISTS "Transcript_audioAssetId_idx" ON "Transcript"("audioAssetId");`,
  `CREATE INDEX IF NOT EXISTS "Transcript_recordingAssetId_idx" ON "Transcript"("recordingAssetId");`,
  `CREATE INDEX IF NOT EXISTS "TranscriptSegment_transcriptId_seq_key" ON "TranscriptSegment"("transcriptId", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ListeningExercise_audioAssetId_idx" ON "ListeningExercise"("audioAssetId");`,
  `CREATE INDEX IF NOT EXISTS "ListeningAttempt_exerciseId_idx" ON "ListeningAttempt"("exerciseId");`,
  `CREATE INDEX IF NOT EXISTS "ListeningError_attemptId_idx" ON "ListeningError"("attemptId");`,
  `CREATE INDEX IF NOT EXISTS "SpeakingPrompt_taskType_idx" ON "SpeakingPrompt"("taskType");`,
  `CREATE INDEX IF NOT EXISTS "SpeakingSession_promptId_idx" ON "SpeakingSession"("promptId");`,
  `CREATE INDEX IF NOT EXISTS "SpeakingTurn_sessionId_idx" ON "SpeakingTurn"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "RecordingAsset_sessionId_idx" ON "RecordingAsset"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "ASRResult_recordingAssetId_idx" ON "ASRResult"("recordingAssetId");`,
  `CREATE INDEX IF NOT EXISTS "SpeechEvaluation_sessionId_idx" ON "SpeechEvaluation"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "SpeechEvaluation_recordingAssetId_idx" ON "SpeechEvaluation"("recordingAssetId");`,
  `CREATE INDEX IF NOT EXISTS "AudioTechnicalCheck_recordingAssetId_idx" ON "AudioTechnicalCheck"("recordingAssetId");`,
];

const NEW_TABLES = [
  'AudioAsset',
  'Transcript',
  'TranscriptSegment',
  'ListeningExercise',
  'ListeningAttempt',
  'ListeningError',
  'SpeakingPrompt',
  'SpeakingSession',
  'SpeakingTurn',
  'RecordingAsset',
  'ASRResult',
  'SpeechEvaluation',
  'AudioTechnicalCheck',
];

const CORE_TABLES = [
  'UserProfile',
  'Stage',
  'PlanTask',
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
];

const PROTECTED_TABLES = [
  'PlanTask',
  'StudySession',
  'StudyRecord',
  'Mistake',
  'ReviewTask',
  'EvidenceRecord',
  'RetestSchedule',
  'VocabularyItem',
  'VocabularyPracticeSession',
  'AIEngineSetting',
  'AIModelConfig',
  'DiagnosticSession',
  'DiagnosticAttempt',
  'AIProviderCredential',
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

function countTable(db, name) {
  if (!tableExists(db, name)) return null;
  return Number(query(db, `SELECT count(*) FROM "${name}";`));
}

function snapshotCounts(db, tables) {
  const out = {};
  for (const table of tables) out[table] = countTable(db, table);
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法：node scripts/migrations/v2.5.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

  --db <路径>        目标数据库（默认 prisma/dev.db）
  --dry-run          只打印将执行的语句，不写库
  --allow-no-backup  跳过「必须已有备份」检查（仅用于副本演练）
`);
    return;
  }

  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`);

  if (!tableExists(opts.db, 'AppMigration')) {
    throw new Error('缺少 AppMigration 表：请先完成 v2.4 及后续迁移');
  }
  const hasV242 = query(opts.db, `SELECT count(*) FROM "AppMigration" WHERE version='v2.4.2';`) === '1';
  if (!hasV242) throw new Error('尚未登记 v2.4.2：请先运行 scripts/migrations/v2.4.2.mjs');

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : [];
    const hasBackup = files.some((name) => /^dev\.db\.before-/.test(name) || /^dev-.*\.db$/.test(name));
    if (!hasBackup) {
      throw new Error('升级真实库前必须先备份：bash scripts/backup.sh（或先跑副本演练）');
    }
  }

  const canonicalSql = [...CREATE_TABLES, ...CREATE_INDEXES].join('\n');
  const checksum = createHash('sha256').update(canonicalSql).digest('hex').slice(0, 16);

  let alreadyApplied = false;
  const registered = query(opts.db, `SELECT checksum FROM "AppMigration" WHERE version='${VERSION}' LIMIT 1;`);
  if (registered) {
    if (registered !== checksum) {
      throw new Error(
        `版本 ${VERSION} 已登记但校验和不一致（库=${registered}，脚本=${checksum}）。请确认脚本来源，禁止直接重跑覆盖。`,
      );
    }
    alreadyApplied = true;
  }

  const before = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);

  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    ...CREATE_TABLES,
    ...CREATE_INDEXES,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.5','${VERSION}','${checksum}','纯加法：听说域 13 表（Listening & Speaking Lab）') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.5 迁移预演（dry-run）==\n数据库：${opts.db}`);
    log(opts, `版本：${VERSION}　校验和：${checksum}　已登记：${alreadyApplied ? '是' : '否'}`);
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
  const coreDrift = PROTECTED_TABLES.filter((table) => before[table] !== after[table]);

  const ok = integrity === 'ok' && fkRows === '' && missingTables.length === 0 && coreDrift.length === 0;

  const report = {
    version: VERSION,
    database: opts.db,
    checksum,
    alreadyApplied,
    appliedAt: new Date().toISOString(),
    durationMs,
    integrity,
    foreignKeyViolations: fkRows ? fkRows.split('\n').length : 0,
    missingTables,
    coreRowDrift: coreDrift,
    before,
    after,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.5-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.5 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增表：${NEW_TABLES.length} 张；核心表行数漂移：${coreDrift.length}`);
  log(opts, `报告：${path.relative(ROOT, reportPath)}`);

  if (!ok) {
    console.error('校验未通过，请用备份回滚：bash scripts/restore.sh <backup>');
    process.exitCode = 1;
  }
}

main();
