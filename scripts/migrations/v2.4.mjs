#!/usr/bin/env node
/**
 * v2.4「AI Learning Engine & Personal Tutor」版本化迁移脚本（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.4.mjs --db /tmp/ielts-v24-drill.db --allow-no-backup
 *   node scripts/migrations/v2.4.mjs --dry-run
 *   node scripts/migrations/v2.4.mjs
 *
 * 设计约束（与 v2.2 / v2.3 同源）：
 * 1. 只做加法：新建 9 张 AI 表 + EvidenceRecord 增加可空列 aiSessionId；不改既有列、不删行。
 * 2. 幂等：CREATE TABLE/INDEX IF NOT EXISTS；加列前检查 PRAGMA table_info；种子用固定 id + 冲突忽略。
 * 3. 事务：DDL、种子与版本登记同一事务；失败回滚。
 * 4. 版本表：AppMigration(version='v2.4', checksum)；同版本不同校验和拒绝执行。
 * 5. 前后核对：核心表行数快照、integrity_check / foreign_key_check，报告写入 backups/migrations/。
 * 6. 回滚：bash scripts/restore.sh <备份>。
 *
 * 依赖：仅 /usr/bin/sqlite3。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.4';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

const MOCK_MODEL_ID = 'aimodel-mock';
const EXTERNAL_MODEL_ID = 'aimodel-openai-compat';
const SETTING_ID = 'default';

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "AIModelConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "capabilitiesJson" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "contextWindow" INTEGER,
    "inputPricePerMtok" REAL NOT NULL DEFAULT 0,
    "outputPricePerMtok" REAL NOT NULL DEFAULT 0,
    "parametersJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "PromptTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promptKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`,
  `CREATE TABLE IF NOT EXISTS "PromptVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemTemplate" TEXT NOT NULL,
    "userTemplate" TEXT NOT NULL,
    "inputSchemaJson" TEXT,
    "outputSchemaJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "testSamplesJson" TEXT,
    "checksum" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    CONSTRAINT "PromptVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PromptTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
];

// 会话表引用顺序：PromptVersion → AIModelConfig 均已建好
CREATE_TABLES.push(
  `CREATE TABLE IF NOT EXISTS "AILearningSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "targetLevel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "promptTemplateKey" TEXT NOT NULL,
    "promptVersionId" TEXT,
    "modelConfigId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baselineText" TEXT,
    "contextJson" TEXT,
    "taskSpecJson" TEXT,
    "rubricJson" TEXT,
    "allowedAidsJson" TEXT,
    "directTeaching" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "pausedAt" DATETIME,
    "failureReason" TEXT,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "parentSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AILearningSession_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AILearningSession_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "AIModelConfig" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AILearningSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "AILearningSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AILearningTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentText" TEXT NOT NULL,
    "structuredJson" TEXT,
    "aidLevel" TEXT,
    "promptVersionId" TEXT,
    "requestId" TEXT,
    "clientRequestId" TEXT,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AILearningTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AILearningSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AILearningTurn_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "LearningTaskInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "linkedPlanTaskId" TEXT,
    "taskSpecJson" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AI',
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 10,
    "difficulty" TEXT,
    "allowedAidsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LearningTaskInstance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AILearningSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AICallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersionId" TEXT,
    "requestId" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "redactedMetadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AICallLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AILearningSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AICallLog_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AISessionFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "helpfulness" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AISessionFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AILearningSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AISessionFeedback_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "AILearningTurn" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "AIEngineSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalAiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyBudgetUsd" REAL NOT NULL DEFAULT 1,
    "monthlyBudgetUsd" REAL NOT NULL DEFAULT 20,
    "warnPercent" INTEGER NOT NULL DEFAULT 80,
    "directTeachingDefault" BOOLEAN NOT NULL DEFAULT false,
    "explainLanguage" TEXT NOT NULL DEFAULT 'ZH_MIXED',
    "updatedAt" DATETIME NOT NULL
);`,
);

const CREATE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "AIModelConfig_provider_model_key" ON "AIModelConfig"("provider", "model");`,
  `CREATE INDEX IF NOT EXISTS "AIModelConfig_isDefault_idx" ON "AIModelConfig"("isDefault");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PromptTemplate_promptKey_key" ON "PromptTemplate"("promptKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_templateId_version_key" ON "PromptVersion"("templateId", "version");`,
  `CREATE INDEX IF NOT EXISTS "PromptVersion_templateId_status_idx" ON "PromptVersion"("templateId", "status");`,
  `CREATE INDEX IF NOT EXISTS "AILearningSession_status_createdAt_idx" ON "AILearningSession"("status", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "AILearningSession_mode_idx" ON "AILearningSession"("mode");`,
  `CREATE INDEX IF NOT EXISTS "AILearningSession_skill_idx" ON "AILearningSession"("skill");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AILearningTurn_sessionId_sequence_key" ON "AILearningTurn"("sessionId", "sequence");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AILearningTurn_sessionId_clientRequestId_key" ON "AILearningTurn"("sessionId", "clientRequestId");`,
  `CREATE INDEX IF NOT EXISTS "AILearningTurn_sessionId_createdAt_idx" ON "AILearningTurn"("sessionId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "LearningTaskInstance_sessionId_idx" ON "LearningTaskInstance"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "LearningTaskInstance_linkedPlanTaskId_idx" ON "LearningTaskInstance"("linkedPlanTaskId");`,
  `CREATE INDEX IF NOT EXISTS "AICallLog_createdAt_idx" ON "AICallLog"("createdAt");`,
  `CREATE INDEX IF NOT EXISTS "AICallLog_status_idx" ON "AICallLog"("status");`,
  `CREATE INDEX IF NOT EXISTS "AICallLog_sessionId_idx" ON "AICallLog"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "AISessionFeedback_sessionId_idx" ON "AISessionFeedback"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "EvidenceRecord_aiSessionId_idx" ON "EvidenceRecord"("aiSessionId");`,
];

const ALTER_EVIDENCE_SQL = `ALTER TABLE "EvidenceRecord" ADD COLUMN "aiSessionId" TEXT REFERENCES "AILearningSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;`;

const SEED_SQL = [
  `INSERT INTO "AIModelConfig" ("id","provider","model","label","capabilitiesJson","active","isDefault","contextWindow","inputPricePerMtok","outputPricePerMtok","parametersJson","updatedAt")
   VALUES ('${MOCK_MODEL_ID}','mock','mock-deterministic','模拟 Provider（离线，不调用真实模型）','["structured_output"]',1,1,NULL,0,0,NULL,CURRENT_TIMESTAMP)
   ON CONFLICT("id") DO NOTHING;`,
  `INSERT INTO "AIModelConfig" ("id","provider","model","label","capabilitiesJson","active","isDefault","contextWindow","inputPricePerMtok","outputPricePerMtok","parametersJson","updatedAt")
   VALUES ('${EXTERNAL_MODEL_ID}','openai-compatible','gpt-4o-mini','OpenAI 兼容（需配置 AI_API_KEY 并开启外部 AI）','["structured_output"]',1,0,128000,0,0,NULL,CURRENT_TIMESTAMP)
   ON CONFLICT("id") DO NOTHING;`,
  `INSERT INTO "AIEngineSetting" ("id","externalAiEnabled","dailyBudgetUsd","monthlyBudgetUsd","warnPercent","directTeachingDefault","explainLanguage","updatedAt")
   VALUES ('${SETTING_ID}',0,1,20,80,0,'ZH_MIXED',CURRENT_TIMESTAMP)
   ON CONFLICT("id") DO NOTHING;`,
];

const NEW_TABLES = [
  'AIModelConfig',
  'PromptTemplate',
  'PromptVersion',
  'AILearningSession',
  'AILearningTurn',
  'LearningTaskInstance',
  'AICallLog',
  'AISessionFeedback',
  'AIEngineSetting',
];

const CORE_TABLES = [
  'UserProfile',
  'Stage',
  'PlanTask',
  'DailyBudget',
  'StudySession',
  'StudyRecord',
  'Mistake',
  'ReviewTask',
  'EvidenceRecord',
  'SkillProfile',
  'RetestSchedule',
  'VocabularyItem',
  'VocabularyPracticeSession',
  'VocabularyKnowledgeState',
  'AppMigration',
];

const PROTECTED_TABLES = ['EvidenceRecord', 'PlanTask', 'StudySession', 'StudyRecord', 'Mistake', 'ReviewTask', 'RetestSchedule', 'VocabularyItem', 'VocabularyPracticeSession'];

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

function columnExists(db, table, column) {
  return query(db, `SELECT count(*) FROM pragma_table_info('${table}') WHERE name='${column}';`) === '1';
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
    console.log(`用法：node scripts/migrations/v2.4.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

  --db <路径>        目标数据库（默认 prisma/dev.db）
  --dry-run          只打印将执行的语句，不写库
  --allow-no-backup  跳过「必须已有备份」检查（仅用于副本演练）
`);
    return;
  }

  if (!existsSync(SQLITE3)) throw new Error(`找不到 ${SQLITE3}`);
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`);

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : [];
    const hasBackup = files.some((name) => /^dev\.db\.before-/.test(name) || /^dev-.*\.db$/.test(name));
    if (!hasBackup) {
      throw new Error('升级真实库前必须先备份：bash scripts/backup.sh（或先跑副本演练）');
    }
  }

  const canonicalSql = [...CREATE_TABLES, ...CREATE_INDEXES, ALTER_EVIDENCE_SQL, ...SEED_SQL].join('\n');
  const checksum = createHash('sha256').update(canonicalSql).digest('hex').slice(0, 16);

  let alreadyApplied = false;
  if (tableExists(opts.db, 'AppMigration')) {
    const row = query(opts.db, `SELECT checksum FROM "AppMigration" WHERE version='${VERSION}' LIMIT 1;`);
    if (row) {
      if (row !== checksum) {
        throw new Error(
          `版本 ${VERSION} 已登记但校验和不一致（库=${row}，脚本=${checksum}）。请确认脚本来源，禁止直接重跑覆盖。`,
        );
      }
      alreadyApplied = true;
    }
  }

  const before = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);
  const needAlter = !columnExists(opts.db, 'EvidenceRecord', 'aiSessionId');

  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    ...CREATE_TABLES,
    ...CREATE_INDEXES,
    ...(needAlter ? [ALTER_EVIDENCE_SQL] : []),
    ...SEED_SQL,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.4','${VERSION}','${checksum}','纯加法：AI 引擎 9 表 + EvidenceRecord.aiSessionId') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.4 迁移预演（dry-run）==\n数据库：${opts.db}`);
    log(opts, `版本：${VERSION}　校验和：${checksum}　已登记：${alreadyApplied ? '是' : '否'}　需要加列：${needAlter ? '是' : '否'}`);
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
  const columnReady = columnExists(opts.db, 'EvidenceRecord', 'aiSessionId');
  const coreDrift = PROTECTED_TABLES.filter((table) => before[table] !== after[table]);

  const ok = integrity === 'ok' && fkRows === '' && missingTables.length === 0 && columnReady && coreDrift.length === 0;

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
    evidenceColumnAdded: columnReady,
    coreRowDrift: coreDrift,
    before,
    after,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.4-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.4 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增表：${NEW_TABLES.length} 张；EvidenceRecord.aiSessionId=${columnReady ? '已存在' : '缺失'}；核心表行数漂移：${coreDrift.length}`);
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