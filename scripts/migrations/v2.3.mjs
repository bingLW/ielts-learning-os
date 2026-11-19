#!/usr/bin/env node
/**
 * v2.3「TypeWords 词汇引擎集成」版本化迁移脚本（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.3.mjs --db /tmp/ielts-v23-drill.db --allow-no-backup   # 副本演练
 *   node scripts/migrations/v2.3.mjs                                                  # 升级 prisma/dev.db
 *   node scripts/migrations/v2.3.mjs --dry-run                                        # 只打印 DDL
 *
 * 设计约束（与 v2.2 同源）：
 * 1. 只做加法：不改既有列、不删行；v2.1/v2.2 的 39 张表保持原样。
 * 2. 幂等：CREATE TABLE/INDEX IF NOT EXISTS；种子数据用固定 id + ON CONFLICT DO NOTHING。
 * 3. 事务：全部 DDL、种子数据与版本登记在同一事务内；失败自动回滚。
 * 4. 版本表：AppMigration(version='v2.3', checksum)；同版本不同校验和 → 拒绝执行。
 * 5. 前后核对：核心表行数快照、PRAGMA foreign_key_check / integrity_check，报告写入 backups/migrations/。
 * 6. 回滚：备份恢复 `bash scripts/restore.sh <backup>`（README §11）。
 *
 * 依赖：仅 /usr/bin/sqlite3，不引入 npm 依赖。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.3';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

// 固定种子 id：迁移可重复执行且报告可复现
const LEGACY_SOURCE_ID = 'vsource-legacy-v21';
const TW_CONNECTION_ID = 'intconn-typewords-file';

// ── 新增表 DDL（与 prisma/schema.prisma 对齐） ──────────────────────────────
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "VocabularySource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceType" TEXT NOT NULL DEFAULT 'IMPORT',
    "title" TEXT NOT NULL,
    "edition" TEXT,
    "license" TEXT,
    "licenseUrl" TEXT,
    "url" TEXT,
    "notes" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lemma" TEXT NOT NULL,
    "displayForm" TEXT,
    "normalizedLemma" TEXT NOT NULL,
    "pos" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'en',
    "senseKey" TEXT NOT NULL DEFAULT 'default',
    "phoneticUk" TEXT,
    "phoneticUs" TEXT,
    "definitionZh" TEXT,
    "definitionEn" TEXT,
    "examplesJson" TEXT,
    "collocationsJson" TEXT,
    "synonymsJson" TEXT,
    "wordFamilyJson" TEXT,
    "tagsJson" TEXT,
    "sourceId" TEXT NOT NULL,
    "sourceRef" TEXT,
    "license" TEXT,
    "externalRefsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VocabularyItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VocabularySource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyItemSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyItemSource_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyItemSource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VocabularySource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyDeck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "targetStage" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "tagsJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "dailyNewTarget" INTEGER NOT NULL DEFAULT 10,
    "reviewCap" INTEGER NOT NULL DEFAULT 40,
    "externalDeckId" TEXT,
    "lastSyncedAt" DATETIME,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VocabularyDeck_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VocabularySource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyDeckItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deckId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyDeckItem_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "VocabularyDeck" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyDeckItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "ExternalWordMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'TYPEWORDS',
    "providerInstanceId" TEXT NOT NULL DEFAULT 'default',
    "externalWordId" TEXT NOT NULL,
    "itemId" TEXT,
    "deckId" TEXT,
    "externalState" TEXT,
    "externalStateJson" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalWordMapping_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExternalWordMapping_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "VocabularyDeck" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "IntegrationConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'TYPEWORDS',
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'FILE',
    "endpoint" TEXT,
    "pinnedVersion" TEXT,
    "capabilitiesJson" TEXT,
    "licenseNote" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS "IntegrationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'TYPEWORDS',
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "fileName" TEXT,
    "payloadHash" TEXT,
    "payloadText" TEXT,
    "countsJson" TEXT,
    "errorReport" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assignmentDate" TEXT NOT NULL,
    "budgetMinutes" INTEGER NOT NULL,
    "reviewTarget" INTEGER NOT NULL DEFAULT 0,
    "newTarget" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "priorityPolicyJson" TEXT,
    "rationale" TEXT,
    "deckId" TEXT,
    "planTaskId" TEXT,
    "externalDeckId" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VocabularyAssignment_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "VocabularyDeck" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VocabularyAssignment_planTaskId_fkey" FOREIGN KEY ("planTaskId") REFERENCES "PlanTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyAssignmentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assignmentId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'P1',
    "kind" TEXT NOT NULL DEFAULT 'NEW',
    "mode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyAssignmentItem_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VocabularyAssignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyAssignmentItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyPracticeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'TYPEWORDS',
    "providerInstanceId" TEXT NOT NULL DEFAULT 'default',
    "externalSessionId" TEXT NOT NULL,
    "deckExternalId" TEXT,
    "mode" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "effectiveSeconds" INTEGER,
    "overlapAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "summaryJson" TEXT,
    "correctCount" INTEGER,
    "incorrectCount" INTEGER,
    "granularity" TEXT NOT NULL DEFAULT 'SUMMARY_ONLY',
    "sourceVersion" TEXT,
    "payloadHash" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobId" TEXT,
    "assignmentId" TEXT,
    "planTaskId" TEXT,
    "studySessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyPracticeSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VocabularyPracticeSession_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VocabularyAssignment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VocabularyPracticeSession_planTaskId_fkey" FOREIGN KEY ("planTaskId") REFERENCES "PlanTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VocabularyPracticeSession_studySessionId_fkey" FOREIGN KEY ("studySessionId") REFERENCES "StudySession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "externalAttemptId" TEXT NOT NULL,
    "externalWordId" TEXT,
    "itemId" TEXT,
    "occurredAt" DATETIME,
    "mode" TEXT,
    "result" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "errorType" TEXT,
    "typedInput" TEXT,
    "hintUsed" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VocabularyPracticeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyAttempt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyKnowledgeState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TEXT,
    "lastEvidenceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VocabularyKnowledgeState_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE TABLE IF NOT EXISTS "VocabularyEvidenceLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "evidenceId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VocabularyEvidenceLink_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyEvidenceLink_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VocabularyItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
];

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS "VocabularySource_sourceType_idx" ON "VocabularySource"("sourceType");',
  'CREATE INDEX IF NOT EXISTS "VocabularySource_archivedAt_idx" ON "VocabularySource"("archivedAt");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItem_lemma_idx" ON "VocabularyItem"("lemma");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItem_normalizedLemma_idx" ON "VocabularyItem"("normalizedLemma");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItem_sourceId_idx" ON "VocabularyItem"("sourceId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItem_status_idx" ON "VocabularyItem"("status");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItem_archivedAt_idx" ON "VocabularyItem"("archivedAt");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyItem_language_normalizedLemma_pos_senseKey_key" ON "VocabularyItem"("language", "normalizedLemma", "pos", "senseKey");',
  'CREATE INDEX IF NOT EXISTS "VocabularyItemSource_sourceId_idx" ON "VocabularyItemSource"("sourceId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyItemSource_itemId_sourceId_sourceRef_key" ON "VocabularyItemSource"("itemId", "sourceId", "sourceRef");',
  'CREATE INDEX IF NOT EXISTS "VocabularyDeck_status_idx" ON "VocabularyDeck"("status");',
  'CREATE INDEX IF NOT EXISTS "VocabularyDeck_targetStage_idx" ON "VocabularyDeck"("targetStage");',
  'CREATE INDEX IF NOT EXISTS "VocabularyDeck_archivedAt_idx" ON "VocabularyDeck"("archivedAt");',
  'CREATE INDEX IF NOT EXISTS "VocabularyDeckItem_deckId_sortOrder_idx" ON "VocabularyDeckItem"("deckId", "sortOrder");',
  'CREATE INDEX IF NOT EXISTS "VocabularyDeckItem_itemId_idx" ON "VocabularyDeckItem"("itemId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyDeckItem_deckId_itemId_key" ON "VocabularyDeckItem"("deckId", "itemId");',
  'CREATE INDEX IF NOT EXISTS "ExternalWordMapping_itemId_idx" ON "ExternalWordMapping"("itemId");',
  'CREATE INDEX IF NOT EXISTS "ExternalWordMapping_deckId_idx" ON "ExternalWordMapping"("deckId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ExternalWordMapping_provider_providerInstanceId_externalWordId_key" ON "ExternalWordMapping"("provider", "providerInstanceId", "externalWordId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAssignment_status_idx" ON "VocabularyAssignment"("status");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAssignment_planTaskId_idx" ON "VocabularyAssignment"("planTaskId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyAssignment_assignmentDate_key" ON "VocabularyAssignment"("assignmentDate");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAssignmentItem_assignmentId_sortOrder_idx" ON "VocabularyAssignmentItem"("assignmentId", "sortOrder");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAssignmentItem_itemId_idx" ON "VocabularyAssignmentItem"("itemId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyAssignmentItem_assignmentId_itemId_key" ON "VocabularyAssignmentItem"("assignmentId", "itemId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyPracticeSession_startedAt_idx" ON "VocabularyPracticeSession"("startedAt");',
  'CREATE INDEX IF NOT EXISTS "VocabularyPracticeSession_assignmentId_idx" ON "VocabularyPracticeSession"("assignmentId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyPracticeSession_planTaskId_idx" ON "VocabularyPracticeSession"("planTaskId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyPracticeSession_jobId_idx" ON "VocabularyPracticeSession"("jobId");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyPracticeSession_provider_providerInstanceId_externalSessionId_key" ON "VocabularyPracticeSession"("provider", "providerInstanceId", "externalSessionId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAttempt_itemId_idx" ON "VocabularyAttempt"("itemId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyAttempt_result_idx" ON "VocabularyAttempt"("result");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyAttempt_sessionId_externalAttemptId_key" ON "VocabularyAttempt"("sessionId", "externalAttemptId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyKnowledgeState_status_idx" ON "VocabularyKnowledgeState"("status");',
  'CREATE INDEX IF NOT EXISTS "VocabularyKnowledgeState_lastVerifiedAt_idx" ON "VocabularyKnowledgeState"("lastVerifiedAt");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyKnowledgeState_itemId_dimension_key" ON "VocabularyKnowledgeState"("itemId", "dimension");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyEvidenceLink_evidenceId_key" ON "VocabularyEvidenceLink"("evidenceId");',
  'CREATE INDEX IF NOT EXISTS "VocabularyEvidenceLink_itemId_dimension_idx" ON "VocabularyEvidenceLink"("itemId", "dimension");',
  'CREATE INDEX IF NOT EXISTS "VocabularyEvidenceLink_evidenceId_idx" ON "VocabularyEvidenceLink"("evidenceId");',
  'CREATE INDEX IF NOT EXISTS "IntegrationConnection_enabled_idx" ON "IntegrationConnection"("enabled");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationConnection_provider_name_key" ON "IntegrationConnection"("provider", "name");',
  'CREATE INDEX IF NOT EXISTS "IntegrationJob_direction_status_idx" ON "IntegrationJob"("direction", "status");',
  'CREATE INDEX IF NOT EXISTS "IntegrationJob_payloadHash_idx" ON "IntegrationJob"("payloadHash");',
  'CREATE INDEX IF NOT EXISTS "IntegrationJob_createdAt_idx" ON "IntegrationJob"("createdAt");',
];

// 种子：既有 VocabWord 幂等迁入 canonical 词条（旧表原样保留，不删不改）
const SEED_SQL = [
  `INSERT INTO "VocabularySource" ("id","sourceType","title","license","notes","updatedAt")
   VALUES ('${LEGACY_SOURCE_ID}','LEGACY','v2.1/v2.2 既有词库（VocabWord）','inherited','由 v2.3 迁移从既有 VocabWord 表幂等复制；原表保留只读',
           CURRENT_TIMESTAMP)
   ON CONFLICT("id") DO NOTHING;`,
  `INSERT INTO "VocabularyItem" ("id","lemma","displayForm","normalizedLemma","pos","language","senseKey",
     "phoneticUk","phoneticUs","definitionZh","definitionEn","examplesJson","collocationsJson",
     "sourceId","sourceRef","license","status","archivedAt","createdAt","updatedAt")
   SELECT 'vocabitem-legacy-' || w."id", w."word", w."word", lower(trim(w."word")),
          COALESCE(w."partOfSpeech",''), 'en', 'default',
          w."phonetic", w."phonetic", w."meaningZh", w."meaningEn",
          CASE WHEN w."exampleSentence" IS NULL OR trim(w."exampleSentence")='' THEN NULL
               ELSE json_array(w."exampleSentence") END,
          CASE WHEN w."collocation" IS NULL OR trim(w."collocation")='' THEN NULL
               ELSE json_array(w."collocation") END,
          '${LEGACY_SOURCE_ID}', 'VocabWord:' || w."id", 'inherited',
          CASE WHEN w."archivedAt" IS NOT NULL THEN 'ARCHIVED' ELSE 'ACTIVE' END,
          w."archivedAt", w."createdAt", w."updatedAt"
   FROM "VocabWord" w
   WHERE NOT EXISTS (
     SELECT 1 FROM "VocabularyItem" v
     WHERE v."language"='en'
       AND v."normalizedLemma"=lower(trim(w."word"))
       AND v."pos"=COALESCE(w."partOfSpeech",'')
       AND v."senseKey"='default'
   );`,
  `INSERT INTO "VocabularyItemSource" ("id","itemId","sourceId","sourceRef","note")
   SELECT 'vocabitemsrc-legacy-' || w."id", 'vocabitem-legacy-' || w."id", '${LEGACY_SOURCE_ID}',
          'VocabWord:' || w."id", '迁移自动登记'
   FROM "VocabWord" w
   WHERE EXISTS (SELECT 1 FROM "VocabularyItem" v WHERE v."id"='vocabitem-legacy-' || w."id")
   ON CONFLICT("id") DO NOTHING;`,
  `INSERT INTO "IntegrationConnection" ("id","provider","name","mode","pinnedVersion","licenseNote","enabled","updatedAt")
   VALUES ('${TW_CONNECTION_ID}','TYPEWORDS','TypeWords（本地文件交换）','FILE',
           '1bcc2a2c0a169b37bea26b73f5a46a91d803558f',
           'TypeWords 采用 GPL-3.0；本产品只做文件交换，不链接、不打包其代码',1,
           CURRENT_TIMESTAMP)
   ON CONFLICT("id") DO NOTHING;`,
];

const NEW_TABLES = [
  'VocabularySource',
  'VocabularyItem',
  'VocabularyItemSource',
  'VocabularyDeck',
  'VocabularyDeckItem',
  'ExternalWordMapping',
  'IntegrationConnection',
  'IntegrationJob',
  'VocabularyAssignment',
  'VocabularyAssignmentItem',
  'VocabularyPracticeSession',
  'VocabularyAttempt',
  'VocabularyKnowledgeState',
  'VocabularyEvidenceLink',
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
  'VocabWord',
  'VocabQuiz',
  'VocabQuizItem',
  'AppMigration',
];

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, dryRun: false, allowNoBackup: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      opts.db = argv[++i];
      if (!opts.db) throw new Error('--db 需要一个路径');
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
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

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法：node scripts/migrations/v2.3.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

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

  const canonicalSql = [...CREATE_TABLES, ...CREATE_INDEXES, ...SEED_SQL].join('\n');
  const checksum = createHash('sha256').update(canonicalSql).digest('hex').slice(0, 16);

  let alreadyApplied = false;
  if (tableExists(opts.db, 'AppMigration')) {
    const row = query(opts.db, `SELECT checksum FROM "AppMigration" WHERE version='${VERSION}' LIMIT 1;`);
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

  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    ...CREATE_TABLES,
    ...CREATE_INDEXES,
    ...SEED_SQL,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.3','${VERSION}','${checksum}','纯加法：词汇域 12 表 + 集成 2 表 + 既有词条幂等迁入') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.3 迁移预演（dry-run）==\n数据库：${opts.db}`);
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
  // VocabWord / VocabQuiz 绝不允许因迁移出现行数变化
  const protectedTables = ['VocabWord', 'VocabQuiz', 'VocabQuizItem', 'EvidenceRecord', 'StudySession', 'PlanTask'];
  const coreDrift = protectedTables.filter((table) => before[table] !== after[table]);
  const legacyWords = before.VocabWord ?? 0;
  const migratedItems = after.VocabularyItem ?? 0;
  const legacyCovered = query(
    opts.db,
    `SELECT count(*) FROM "VocabularyItem" WHERE "sourceId"='${LEGACY_SOURCE_ID}';`,
  );

  const ok =
    integrity === 'ok' &&
    fkRows === '' &&
    missingTables.length === 0 &&
    coreDrift.length === 0 &&
    Number(legacyCovered) === legacyWords;

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
    legacy: { vocabWordRows: legacyWords, canonicalLegacyItems: Number(legacyCovered), totalCanonicalItems: migratedItems },
    before,
    after,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.3-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.3 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增/校验表：${NEW_TABLES.length} 张；既有 VocabWord ${legacyWords} 行 → canonical ${Number(legacyCovered)} 行；核心表行数漂移：${coreDrift.length}`);
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
