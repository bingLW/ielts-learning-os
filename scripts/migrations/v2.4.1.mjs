#!/usr/bin/env node
/**
 * v2.4.1「AI Diagnostic & Intelligent Placement」版本化迁移（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.4.1.mjs --db /tmp/ielts-v241-drill.db --allow-no-backup
 *   node scripts/migrations/v2.4.1.mjs --dry-run
 *   node scripts/migrations/v2.4.1.mjs
 *
 * 约束（与 v2.2 / v2.3 / v2.4 同源）：
 * 1. 只做加法：新建 11 张诊断域表 + 索引；不改既有列、不删行。
 * 2. 幂等：CREATE TABLE/INDEX IF NOT EXISTS；同版本不同 checksum 拒绝执行。
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
const VERSION = 'v2.4.1';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "LearnerProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "goalsJson" TEXT,
    "backgroundJson" TEXT,
    "recordingConsent" BOOLEAN NOT NULL DEFAULT false,
    "externalAiConsent" BOOLEAN NOT NULL DEFAULT false,
    "selfReportedWeaknessJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticBlueprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosticBlueprint_code_key" ON "DiagnosticBlueprint"("code");`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blueprintId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "subskill" TEXT NOT NULL,
    "targetLevelMin" TEXT NOT NULL,
    "targetLevelMax" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 2,
    "taskType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "passage" TEXT,
    "transcript" TEXT,
    "optionsJson" TEXT,
    "correctAnswer" TEXT,
    "answerExplanation" TEXT,
    "rubricJson" TEXT,
    "rubricVersion" TEXT NOT NULL DEFAULT 'v1',
    "validationStatus" TEXT NOT NULL DEFAULT 'VERIFIED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiagnosticItem_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "DiagnosticBlueprint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosticItem_itemCode_key" ON "DiagnosticItem"("itemCode");`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticItem_skill_difficulty_idx" ON "DiagnosticItem"("skill", "difficulty");`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticItem_sourceType_idx" ON "DiagnosticItem"("sourceType");`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blueprintId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "goalSnapshotJson" TEXT,
    "planJson" TEXT,
    "currentItemId" TEXT,
    "startedAt" DATETIME,
    "lastActivityAt" DATETIME,
    "completedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiagnosticSession_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "DiagnosticBlueprint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticSession_status_idx" ON "DiagnosticSession"("status");`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticSession_createdAt_idx" ON "DiagnosticSession"("createdAt");`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "responseText" TEXT,
    "responseJson" TEXT,
    "timeSpentSec" INTEGER,
    "technicalStatusJson" TEXT,
    "score" INTEGER,
    "maxScore" INTEGER,
    "evaluatorType" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "rubricVersion" TEXT,
    "evidenceId" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiagnosticAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosticSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiagnosticAttempt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "DiagnosticItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DiagnosticAttempt_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosticAttempt_evidenceId_key" ON "DiagnosticAttempt"("evidenceId");`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticAttempt_sessionId_status_idx" ON "DiagnosticAttempt"("sessionId", "status");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosticAttempt_sessionId_itemId_sequence_key" ON "DiagnosticAttempt"("sessionId", "itemId", "sequence");`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storagePath" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "durationSec" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiagnosticAsset_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DiagnosticAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticAsset_attemptId_idx" ON "DiagnosticAsset"("attemptId");`,
  `CREATE TABLE IF NOT EXISTS "AssessmentResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "subskill" TEXT NOT NULL,
    "dimensionJson" TEXT,
    "estimatedLevel" TEXT,
    "levelRangeJson" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "rubricVersion" TEXT,
    "evidenceRefsJson" TEXT,
    "limitationsJson" TEXT,
    "needsFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "assessorType" TEXT NOT NULL DEFAULT 'AI',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssessmentResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DiagnosticAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentResult_attemptId_key" ON "AssessmentResult"("attemptId");`,
  `CREATE TABLE IF NOT EXISTS "SkillProfileSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "estimatedLevel" TEXT,
    "levelRangeJson" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "coverageJson" TEXT,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "limitationsJson" TEXT,
    "needsFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillProfileSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosticSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SkillProfileSnapshot_sessionId_skill_key" ON "SkillProfileSnapshot"("sessionId", "skill");`,
  `CREATE TABLE IF NOT EXISTS "PlacementReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'FINAL',
    "summary" TEXT NOT NULL,
    "strengthsJson" TEXT,
    "gapsJson" TEXT,
    "coverageJson" TEXT,
    "suggestionsJson" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "limitationsJson" TEXT,
    "supersededById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlacementReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosticSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PlacementReport_sessionId_key" ON "PlacementReport"("sessionId");`,
  `CREATE TABLE IF NOT EXISTS "PlanProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "horizonDays" INTEGER NOT NULL,
    "tasksJson" TEXT NOT NULL,
    "rationaleJson" TEXT,
    "budgetJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    CONSTRAINT "PlanProposal_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "PlacementReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE INDEX IF NOT EXISTS "PlanProposal_status_idx" ON "PlanProposal"("status");`,
  `CREATE TABLE IF NOT EXISTS "DiagnosticReviewRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiagnosticReviewRequest_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "PlacementReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE INDEX IF NOT EXISTS "DiagnosticReviewRequest_status_idx" ON "DiagnosticReviewRequest"("status");`,
];

const NEW_TABLES = [
  'LearnerProfile',
  'DiagnosticBlueprint',
  'DiagnosticItem',
  'DiagnosticSession',
  'DiagnosticAttempt',
  'DiagnosticAsset',
  'AssessmentResult',
  'SkillProfileSnapshot',
  'PlacementReport',
  'PlanProposal',
  'DiagnosticReviewRequest',
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
    console.log(`用法：node scripts/migrations/v2.4.1.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

  --db <路径>        目标数据库（默认 prisma/dev.db）
  --dry-run          只打印将执行的语句，不写库
  --allow-no-backup  跳过「必须已有备份」检查（仅用于副本演练）
`);
    return;
  }

  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`);

  if (!tableExists(opts.db, 'AppMigration')) {
    throw new Error('缺少 AppMigration 表：请先完成 v2.4 迁移');
  }
  const hasV24 = query(opts.db, `SELECT count(*) FROM "AppMigration" WHERE version='v2.4';`) === '1';
  if (!hasV24) throw new Error('尚未登记 v2.4：请先运行 scripts/migrations/v2.4.mjs');

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : [];
    const hasBackup = files.some((name) => /^dev\.db\.before-/.test(name) || /^dev-.*\.db$/.test(name));
    if (!hasBackup) {
      throw new Error('升级真实库前必须先备份：bash scripts/backup.sh（或先跑副本演练）');
    }
  }

  const canonicalSql = CREATE_TABLES.join('\n');
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
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.4.1','${VERSION}','${checksum}','纯加法：诊断域 11 表（蓝图/题库/会话/尝试/资产/评分/画像/报告/计划草案/复核/学习者背景）') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.4.1 迁移预演（dry-run）==\n数据库：${opts.db}`);
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
  const reportPath = path.join(REPORT_DIR, `v2.4.1-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.4.1 迁移${ok ? '完成' : '校验失败'} ==`);
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

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
