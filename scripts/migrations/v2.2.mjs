#!/usr/bin/env node
/**
 * v2.2「证据化学习」版本化迁移脚本（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.2.mjs --db /tmp/ielts-v22-drill.db     # 副本演练
 *   node scripts/migrations/v2.2.mjs                                   # 升级 prisma/dev.db（要求已有备份）
 *   node scripts/migrations/v2.2.mjs --dry-run                         # 只打印将执行的 DDL
 *
 * 设计约束（docs/07-v2.2-gap-analysis.md §9）：
 * 1. 只做加法：不动既有列、不删行、不改默认值；已有 29 张表保持原样。
 * 2. 幂等：CREATE TABLE/INDEX IF NOT EXISTS；ALTER TABLE ADD COLUMN 先查 PRAGMA 再补。
 * 3. 事务：全部 DDL 与版本登记在同一事务内；失败自动回滚（sqlite3 -bail + ROLLBACK）。
 * 4. 版本表：AppMigration(version='v2.2', checksum)；同版本不同校验和 → 拒绝执行，
 *    防止「脚本被改过却假装已升级」。
 * 5. 前后核对：各表行数快照、PRAGMA foreign_key_check、integrity_check，
 *    报告写入 backups/migrations/。
 * 6. 回滚：首选备份恢复 `bash scripts/restore.sh <backup>`（见 README §11）。
 *
 * 依赖：仅 /usr/bin/sqlite3（备份脚本同源约定），不引入 npm 依赖。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.2';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

// ── 新增表 DDL（与 prisma/schema.prisma 对齐；顺序满足外键引用可读性） ──────────
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "EvidenceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skill" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'QUICK',
    "parentEvidenceId" TEXT,
    "chainRootId" TEXT,
    "taskId" TEXT,
    "sessionId" TEXT,
    "mediatedId" TEXT,
    "artifactId" TEXT,
    "conditionJson" TEXT,
    "outputText" TEXT,
    "score" INTEGER,
    "scoreReason" TEXT,
    "dimensionsJson" TEXT,
    "evidenceAnchor" TEXT,
    "assistanceLevel" TEXT NOT NULL DEFAULT 'A0',
    "assessorType" TEXT NOT NULL DEFAULT 'SELF',
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "privacyLevel" TEXT NOT NULL DEFAULT 'PRIVATE',
    "note" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvidenceRecord_parentEvidenceId_fkey" FOREIGN KEY ("parentEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EvidenceRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PlanTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EvidenceRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EvidenceRecord_mediatedId_fkey" FOREIGN KEY ("mediatedId") REFERENCES "EnglishMediatedSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EvidenceRecord_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "EvidenceAttachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "SkillProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skill" TEXT NOT NULL,
    "direction" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "evidenceBasis" TEXT,
    "lastAssessedAt" TEXT,
    "reviewDueAt" TEXT,
    "doNotInfer" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "LearningCycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "deliverable" TEXT,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CALIBRATION',
    "baselineRefs" TEXT,
    "recoveryNote" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "BarrierDiagnosis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skill" TEXT NOT NULL,
    "barrierType" TEXT NOT NULL,
    "evidenceId" TEXT,
    "evidenceAnchor" TEXT,
    "impact" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "selectedFocus" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cycleId" TEXT,
    "note" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BarrierDiagnosis_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BarrierDiagnosis_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "LearningCycle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "InterventionPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "barrierId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "successCriteria" TEXT NOT NULL,
    "scaffoldLevel" TEXT NOT NULL DEFAULT 'A1',
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 15,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "preEvidenceId" TEXT,
    "postEvidenceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterventionPlan_barrierId_fkey" FOREIGN KEY ("barrierId") REFERENCES "BarrierDiagnosis" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InterventionPlan_preEvidenceId_fkey" FOREIGN KEY ("preEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InterventionPlan_postEvidenceId_fkey" FOREIGN KEY ("postEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "RetestSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentEvidenceId" TEXT NOT NULL,
    "retestType" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "estMinutes" INTEGER NOT NULL DEFAULT 10,
    "completedEvidenceId" TEXT,
    "planTaskId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RetestSchedule_parentEvidenceId_fkey" FOREIGN KEY ("parentEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RetestSchedule_completedEvidenceId_fkey" FOREIGN KEY ("completedEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RetestSchedule_planTaskId_fkey" FOREIGN KEY ("planTaskId") REFERENCES "PlanTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "WeeklyFocus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cycleId" TEXT NOT NULL,
    "weekIndex" INTEGER NOT NULL,
    "weekStart" TEXT NOT NULL,
    "focusQuestion" TEXT NOT NULL,
    "inputText" TEXT,
    "outputText" TEXT,
    "feedbackText" TEXT,
    "transferEvidenceId" TEXT,
    "nextDecision" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WeeklyFocus_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "LearningCycle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AIUsageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "evidenceId" TEXT,
    "beforeEvidenceId" TEXT,
    "afterEvidenceId" TEXT,
    "toolName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "assistanceLevel" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "purpose" TEXT,
    "inputRef" TEXT,
    "outputRef" TEXT,
    "adoptedOrRejected" TEXT NOT NULL DEFAULT 'ADOPTED',
    "userNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AIUsageRecord_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AIUsageRecord_beforeEvidenceId_fkey" FOREIGN KEY ("beforeEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AIUsageRecord_afterEvidenceId_fkey" FOREIGN KEY ("afterEvidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "ResourceReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "creator" TEXT,
    "url" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL DEFAULT 'ARTICLE',
    "priority" TEXT NOT NULL DEFAULT 'P1',
    "sourceUpdated" TEXT,
    "accessedAt" TEXT,
    "licenseNote" TEXT,
    "stageFit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "category" TEXT,
    "summary" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "ResourceReadingLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "personalSummary" TEXT,
    "plannedAction" TEXT,
    "appliedEvidenceId" TEXT,
    "lastReadAt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResourceReadingLog_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "ResourceReference" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AppMigration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "checksum" TEXT,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT
);`,
];

// EvidenceAttachment 扩展列（v2.1 库缺少这些列；按 PRAGMA 结果逐条补）。
const ATTACHMENT_COLUMNS = [
  ['sizeBytes', 'INTEGER'],
  ['checksum', 'TEXT'],
  ['privacyLevel', "TEXT NOT NULL DEFAULT 'PRIVATE'"],
  ['consentStatus', "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'"],
];

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_skill_evidenceType_idx" ON "EvidenceRecord"("skill", "evidenceType");',
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_parentEvidenceId_idx" ON "EvidenceRecord"("parentEvidenceId");',
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_chainRootId_idx" ON "EvidenceRecord"("chainRootId");',
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_createdAt_idx" ON "EvidenceRecord"("createdAt");',
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_archivedAt_idx" ON "EvidenceRecord"("archivedAt");',
  'CREATE INDEX IF NOT EXISTS "EvidenceRecord_privacyLevel_idx" ON "EvidenceRecord"("privacyLevel");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "SkillProfile_skill_key" ON "SkillProfile"("skill");',
  'CREATE INDEX IF NOT EXISTS "LearningCycle_status_startDate_idx" ON "LearningCycle"("status", "startDate");',
  'CREATE INDEX IF NOT EXISTS "BarrierDiagnosis_skill_selectedFocus_idx" ON "BarrierDiagnosis"("skill", "selectedFocus");',
  'CREATE INDEX IF NOT EXISTS "BarrierDiagnosis_cycleId_idx" ON "BarrierDiagnosis"("cycleId");',
  'CREATE INDEX IF NOT EXISTS "BarrierDiagnosis_status_idx" ON "BarrierDiagnosis"("status");',
  'CREATE INDEX IF NOT EXISTS "InterventionPlan_barrierId_status_idx" ON "InterventionPlan"("barrierId", "status");',
  'CREATE INDEX IF NOT EXISTS "InterventionPlan_status_idx" ON "InterventionPlan"("status");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "RetestSchedule_idempotencyKey_key" ON "RetestSchedule"("idempotencyKey");',
  'CREATE INDEX IF NOT EXISTS "RetestSchedule_status_dueDate_idx" ON "RetestSchedule"("status", "dueDate");',
  'CREATE INDEX IF NOT EXISTS "RetestSchedule_parentEvidenceId_idx" ON "RetestSchedule"("parentEvidenceId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "RetestSchedule_parentEvidenceId_retestType_dueDate_key" ON "RetestSchedule"("parentEvidenceId", "retestType", "dueDate");',
  'CREATE INDEX IF NOT EXISTS "WeeklyFocus_weekStart_idx" ON "WeeklyFocus"("weekStart");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "WeeklyFocus_cycleId_weekIndex_key" ON "WeeklyFocus"("cycleId", "weekIndex");',
  'CREATE INDEX IF NOT EXISTS "AIUsageRecord_createdAt_idx" ON "AIUsageRecord"("createdAt");',
  'CREATE INDEX IF NOT EXISTS "AIUsageRecord_assistanceLevel_idx" ON "AIUsageRecord"("assistanceLevel");',
  'CREATE INDEX IF NOT EXISTS "AIUsageRecord_evidenceId_idx" ON "AIUsageRecord"("evidenceId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ResourceReference_url_key" ON "ResourceReference"("url");',
  'CREATE INDEX IF NOT EXISTS "ResourceReference_priority_sortOrder_idx" ON "ResourceReference"("priority", "sortOrder");',
  'CREATE INDEX IF NOT EXISTS "ResourceReference_status_idx" ON "ResourceReference"("status");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ResourceReadingLog_resourceId_key" ON "ResourceReadingLog"("resourceId");',
  'CREATE INDEX IF NOT EXISTS "ResourceReadingLog_status_idx" ON "ResourceReadingLog"("status");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AppMigration_version_key" ON "AppMigration"("version");',
  'CREATE INDEX IF NOT EXISTS "EvidenceAttachment_privacyLevel_idx" ON "EvidenceAttachment"("privacyLevel");',
];

const NEW_TABLES = [
  'EvidenceRecord',
  'SkillProfile',
  'LearningCycle',
  'BarrierDiagnosis',
  'InterventionPlan',
  'RetestSchedule',
  'WeeklyFocus',
  'AIUsageRecord',
  'ResourceReference',
  'ResourceReadingLog',
  'AppMigration',
];

const CORE_TABLES = [
  'Stage',
  'StageAcceptanceItem',
  'Resource',
  'PlanTask',
  'PlanVersion',
  'DailyBudget',
  'StudySession',
  'StudySessionDaySplit',
  'DailySummary',
  'SkillAllocationProfile',
  'LearningGoal',
  'GoalMilestone',
  'UserProfile',
  'PlannerSettings',
];

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, dryRun: false, checksumOnly: false, allowNoBackup: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      opts.db = argv[++i];
      if (!opts.db) throw new Error('--db 需要一个路径');
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--checksum-only') {
      opts.checksumOnly = true;
    } else if (arg === '--allow-no-backup') {
      opts.allowNoBackup = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  opts.db = path.resolve(opts.db);
  return opts;
}

function log(opts, message) {
  if (!opts.quiet) console.log(message);
}

// ── sqlite3 封装 ────────────────────────────────────────────────────────────
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

function attachmentColumnNames(db) {
  const rows = query(db, 'PRAGMA table_info("EvidenceAttachment");');
  return rows
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|')[1]);
}

// 权威 checksum 只由规范 SQL 决定；checksum-only 模式在任何 DB 检查之前返回。
const canonicalAlters = ATTACHMENT_COLUMNS.map(
  ([name, type]) => `ALTER TABLE "EvidenceAttachment" ADD COLUMN "${name}" ${type};`,
);
const canonicalSql = [...CREATE_TABLES, ...canonicalAlters, ...CREATE_INDEXES].join('\n');
const checksum = createHash('sha256').update(canonicalSql).digest('hex').slice(0, 16);

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法：node scripts/migrations/v2.2.mjs [--db <路径>] [--dry-run] [--checksum-only] [--allow-no-backup]

  --db <路径>        目标数据库（默认 prisma/dev.db）
  --dry-run          只打印将执行的语句，不写库
  --checksum-only    只输出权威 checksum，不读/写数据库
  --allow-no-backup  跳过「必须已有 backups/dev-*.db」检查（仅用于一次性副本演练）
`);
    return;
  }
  if (opts.checksumOnly) {
    console.log(checksum);
    return;
  }

  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`);

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    const hasBackup =
      existsSync(BACKUP_DIR) && readdirSync(BACKUP_DIR).some((name) => /^dev-.*\.db$/.test(name));
    if (!hasBackup) {
      throw new Error('升级真实库前必须先备份：bash scripts/backup.sh（或先跑副本演练）');
    }
  }

  const attachmentColumns = attachmentColumnNames(opts.db);
  const missingColumns = ATTACHMENT_COLUMNS.filter(([name]) => !attachmentColumns.includes(name));
  const alters = missingColumns.map(
    ([name, type]) => `ALTER TABLE "EvidenceAttachment" ADD COLUMN "${name}" ${type};`,
  );

  // 同版本校验和必须一致；不同则拒绝执行，避免「脚本改过但仍标已迁移」。
  let alreadyApplied = false;
  if (tableExists(opts.db, 'AppMigration')) {
    const row = query(
      opts.db,
      `SELECT checksum FROM "AppMigration" WHERE version='${VERSION}' LIMIT 1;`,
    );
    if (row) {
      if (row !== checksum) {
        throw new Error(
          `版本 ${VERSION} 已登记但校验和不一致（库=${row}，脚本=${checksum}）。` +
            '请确认脚本来源，禁止直接重跑覆盖。',
        );
      }
      alreadyApplied = true;
    }
  }

  const before = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);
  const beforeAttachments = countTable(opts.db, 'EvidenceAttachment');

  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    ...CREATE_TABLES,
    ...alters,
    ...CREATE_INDEXES,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.2','${VERSION}','${checksum}','纯加法：证据域 10 表 + EvidenceAttachment 4 列') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.2 迁移预演（dry-run）==\n数据库：${opts.db}`);
    log(opts, `版本：${VERSION}　校验和：${checksum}　已登记：${alreadyApplied ? '是' : '否'}`);
    log(opts, `将补列：${missingColumns.map(([name]) => name).join(', ') || '（无）'}`);
    log(opts, transactionSql);
    return;
  }

  const startedAt = Date.now();
  try {
    runSql(opts.db, transactionSql);
  } catch (error) {
    // 事务失败时 sqlite3 -bail 会退出，未 COMMIT 的变更由 SQLite 自动回滚。
    throw new Error(`迁移失败，未提交（已回滚）：${error.stderr || error.message}`);
  }
  const durationMs = Date.now() - startedAt;

  const integrity = query(opts.db, 'PRAGMA integrity_check;');
  const fkRows = query(opts.db, 'PRAGMA foreign_key_check;');
  const after = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);
  const afterAttachments = countTable(opts.db, 'EvidenceAttachment');

  const missingTables = NEW_TABLES.filter((name) => !tableExists(opts.db, name));
  const remainingColumns = ATTACHMENT_COLUMNS.filter(
    ([name]) => !attachmentColumnNames(opts.db).includes(name),
  );

  const coreDrift = CORE_TABLES.filter((table) => before[table] !== after[table]);
  const ok =
    integrity === 'ok' &&
    fkRows === '' &&
    missingTables.length === 0 &&
    remainingColumns.length === 0 &&
    coreDrift.length === 0 &&
    beforeAttachments === afterAttachments;

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
    missingColumns: remainingColumns.map(([name]) => name),
    coreRowDrift: coreDrift,
    evidenceAttachments: { before: beforeAttachments, after: afterAttachments },
    before,
    after,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.2-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.2 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增/校验表：${NEW_TABLES.length} 张；补列：${missingColumns.length} 个；核心表行数漂移：${coreDrift.length}`);
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
