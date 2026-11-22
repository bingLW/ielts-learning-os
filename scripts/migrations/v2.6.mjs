#!/usr/bin/env node
/**
 * v2.6「Smart Learning Materials」版本化迁移（纯加法）。
 *
 * 用法：
 *   node scripts/migrations/v2.6.mjs --db /tmp/ielts-v26-drill.db --dry-run
 *   node scripts/migrations/v2.6.mjs --db /tmp/ielts-v26-drill.db --allow-no-backup
 *   node scripts/migrations/v2.6.mjs
 *
 * 约束（与 v2.2 / v2.3 / v2.4 / v2.4.1 / v2.4.2 / v2.5 同源）：
 * 1. 只做加法：新建 17 张材料域表；既有表仅 AICallLog 追加 2 个可空列 + 1 个索引。
 *    不删列、不改列语义、不删行。
 * 2. 幂等：CREATE TABLE / CREATE INDEX IF NOT EXISTS；ADD COLUMN 先读 PRAGMA table_info；
 *    同版本不同 checksum 拒绝执行（防脚本被悄悄改动）。
 * 3. 事务：DDL + 版本登记同一事务（BEGIN IMMEDIATE）；失败回滚。
 * 4. 前后核对：受保护表行数、integrity_check、foreign_key_check；报告写入 backups/migrations/。
 * 5. 回滚：bash scripts/restore.sh <备份>。v2.6 为纯加法，回滚 = 恢复备份；
 *    单独 DROP 新表会丢派生数据（解析结果、AI 抽取、练习、草案），不建议。
 *
 * DDL 来源：与 prisma/schema.prisma 经 `prisma db push` 生成的结构**逐字节一致**
 * （含外键约束名），因此迁移后再 `prisma db push` 是零变更，不会重建表。
 *
 * 依赖：仅 /usr/bin/sqlite3。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const VERSION = 'v2.6';
const PREVIOUS_VERSIONS = ['v2.5'];
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'prisma', 'dev.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPORT_DIR = path.join(BACKUP_DIR, 'migrations');

/** 按依赖顺序排列（父表先建；SQLite 允许前向引用外键，但保持顺序更易审阅）。 */
const NEW_TABLES = [
  'LearningMaterial',
  'MaterialSource',
  'MaterialPermissionRecord',
  'MaterialAsset',
  'ProcessingJob',
  'ParsedDocument',
  'ContentChunk',
  'ExtractionResult',
  'VocabularyCandidate',
  'SentenceCandidate',
  'MaterialExerciseSet',
  'GeneratedExercise',
  'ExerciseAttempt',
  'MaterialPack',
  'MaterialPackItem',
  'TaskProposal',
  'TaskProposalItem',
];

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "LearningMaterial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "statusReason" TEXT,
    "sourceType" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "originFileName" TEXT,
    "fileHash" TEXT,
    "contentHash" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutes" INTEGER,
    "targetSkillsJson" TEXT,
    "difficultyEstimate" TEXT,
    "learnerLevelAtGen" TEXT,
    "duplicateOfId" TEXT,
    "resourceId" TEXT,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LearningMaterial_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "url" TEXT,
    "author" TEXT,
    "publisher" TEXT,
    "publishedYear" INTEGER,
    "licenseName" TEXT,
    "licenseUrl" TEXT,
    "userNote" TEXT,
    "rightsConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "rightsConfirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MaterialSource_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialPermissionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialPermissionRecord_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "isReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "audioAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialAsset_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "ProcessingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'validating',
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "lockVersion" INTEGER NOT NULL DEFAULT 0,
    "progressJson" TEXT,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTickAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "ProcessingJob_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "ParsedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parserName" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "pageCount" INTEGER,
    "paragraphCount" INTEGER NOT NULL DEFAULT 0,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT,
    "textChecksum" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParsedDocument_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "ContentChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "parsedDocumentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MIXED',
    "headingPath" TEXT,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "estTokens" INTEGER NOT NULL DEFAULT 0,
    "suspicionFlags" TEXT,
    "prevChunkId" TEXT,
    "nextChunkId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentChunk_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentChunk_parsedDocumentId_fkey" FOREIGN KEY ("parsedDocumentId") REFERENCES "ParsedDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "ExtractionResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "chunkId" TEXT,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "sourceQuote" TEXT NOT NULL,
    "sourceChunkIdsJson" TEXT,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "sourceVerified" BOOLEAN NOT NULL DEFAULT false,
    "isDerived" BOOLEAN NOT NULL DEFAULT true,
    "aiCallLogId" TEXT,
    "promptVersionId" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'draft',
    "editedPayloadJson" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExtractionResult_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExtractionResult_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "ContentChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "VocabularyCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "surfaceForm" TEXT NOT NULL,
    "lemma" TEXT NOT NULL,
    "normalizedLemma" TEXT NOT NULL,
    "pos" TEXT NOT NULL DEFAULT '',
    "senseKey" TEXT NOT NULL DEFAULT 'default',
    "definitionZh" TEXT,
    "definitionEn" TEXT,
    "collocationsJson" TEXT,
    "contextSentence" TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "existsInLibrary" BOOLEAN NOT NULL DEFAULT false,
    "existingItemId" TEXT,
    "isDerived" BOOLEAN NOT NULL DEFAULT true,
    "aiCallLogId" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'draft',
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "syncedItemId" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VocabularyCandidate_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VocabularyCandidate_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "ContentChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "SentenceCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "sentenceText" TEXT NOT NULL,
    "skeletonText" TEXT,
    "complexity" TEXT,
    "grammarPointsJson" TEXT,
    "note" TEXT,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "isDerived" BOOLEAN NOT NULL DEFAULT true,
    "aiCallLogId" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SentenceCandidate_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SentenceCandidate_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "ContentChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialExerciseSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetSkill" TEXT NOT NULL,
    "difficultyLevel" TEXT,
    "orderingJson" TEXT,
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 10,
    "hasApprovedOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MaterialExerciseSet_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "GeneratedExercise" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetSkill" TEXT NOT NULL,
    "subskill" TEXT,
    "auxiliaryDimensionsJson" TEXT,
    "difficultyEstimate" TEXT,
    "prompt" TEXT NOT NULL,
    "answerJson" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidenceQuote" TEXT NOT NULL,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "isAiGenerated" BOOLEAN NOT NULL DEFAULT true,
    "reviewStatus" TEXT NOT NULL DEFAULT 'draft',
    "consistencyCheck" TEXT NOT NULL DEFAULT 'unchecked',
    "consistencyNote" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "model" TEXT,
    "promptVersionId" TEXT,
    "aiCallLogId" TEXT,
    "retiredAt" DATETIME,
    "retireReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GeneratedExercise_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GeneratedExercise_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MaterialExerciseSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GeneratedExercise_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "ContentChunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "ExerciseAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "isCorrect" BOOLEAN,
    "reviewStatusAtAttempt" TEXT NOT NULL,
    "evidenceId" TEXT,
    "evidenceType" TEXT NOT NULL DEFAULT 'PRACTICE_ONLY',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExerciseAttempt_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExerciseAttempt_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MaterialExerciseSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExerciseAttempt_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "GeneratedExercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialPack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "learningGoalsJson" TEXT,
    "targetSkillsJson" TEXT,
    "difficultyEstimate" TEXT,
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 30,
    "orderingJson" TEXT,
    "summaryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MaterialPack_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "MaterialPackItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutes" INTEGER,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialPackItem_packId_fkey" FOREIGN KEY ("packId") REFERENCES "MaterialPack" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "TaskProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "packId" TEXT,
    "baseDate" TEXT NOT NULL,
    "budgetMinutes" INTEGER NOT NULL,
    "totalMinutes" INTEGER NOT NULL,
    "overflowDays" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rationale" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskProposal_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "LearningMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS "TaskProposalItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proposalId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "targetSkill" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "suggestedMinutes" INTEGER NOT NULL,
    "finalMinutes" INTEGER,
    "suggestedDate" TEXT NOT NULL,
    "finalDate" TEXT,
    "granularity" INTEGER NOT NULL DEFAULT 30,
    "reason" TEXT,
    "exerciseIdsJson" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "planTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskProposalItem_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "TaskProposal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
];

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_contentHash_idx" ON "LearningMaterial"("contentHash");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_status_idx" ON "LearningMaterial"("status");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_format_idx" ON "LearningMaterial"("format");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_sourceType_idx" ON "LearningMaterial"("sourceType");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_createdAt_idx" ON "LearningMaterial"("createdAt");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_resourceId_idx" ON "LearningMaterial"("resourceId");`,
  `CREATE INDEX IF NOT EXISTS "LearningMaterial_duplicateOfId_idx" ON "LearningMaterial"("duplicateOfId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MaterialSource_materialId_key" ON "MaterialSource"("materialId");`,
  `CREATE INDEX IF NOT EXISTS "MaterialPermissionRecord_materialId_action_idx" ON "MaterialPermissionRecord"("materialId", "action");`,
  `CREATE INDEX IF NOT EXISTS "MaterialAsset_materialId_kind_idx" ON "MaterialAsset"("materialId", "kind");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MaterialAsset_materialId_relativePath_key" ON "MaterialAsset"("materialId", "relativePath");`,
  `CREATE INDEX IF NOT EXISTS "ProcessingJob_materialId_startedAt_idx" ON "ProcessingJob"("materialId", "startedAt");`,
  `CREATE INDEX IF NOT EXISTS "ProcessingJob_status_idx" ON "ProcessingJob"("status");`,
  `CREATE INDEX IF NOT EXISTS "ParsedDocument_materialId_isCurrent_idx" ON "ParsedDocument"("materialId", "isCurrent");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ParsedDocument_materialId_version_key" ON "ParsedDocument"("materialId", "version");`,
  `CREATE INDEX IF NOT EXISTS "ContentChunk_materialId_seq_idx" ON "ContentChunk"("materialId", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ContentChunk_materialId_page_idx" ON "ContentChunk"("materialId", "page");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ContentChunk_parsedDocumentId_seq_key" ON "ContentChunk"("parsedDocumentId", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ExtractionResult_materialId_kind_reviewStatus_idx" ON "ExtractionResult"("materialId", "kind", "reviewStatus");`,
  `CREATE INDEX IF NOT EXISTS "ExtractionResult_materialId_page_idx" ON "ExtractionResult"("materialId", "page");`,
  `CREATE INDEX IF NOT EXISTS "ExtractionResult_chunkId_idx" ON "ExtractionResult"("chunkId");`,
  `CREATE INDEX IF NOT EXISTS "VocabularyCandidate_materialId_reviewStatus_idx" ON "VocabularyCandidate"("materialId", "reviewStatus");`,
  `CREATE INDEX IF NOT EXISTS "VocabularyCandidate_materialId_syncStatus_idx" ON "VocabularyCandidate"("materialId", "syncStatus");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VocabularyCandidate_materialId_normalizedLemma_pos_senseKey_contextHash_key" ON "VocabularyCandidate"("materialId", "normalizedLemma", "pos", "senseKey", "contextHash");`,
  `CREATE INDEX IF NOT EXISTS "SentenceCandidate_materialId_reviewStatus_idx" ON "SentenceCandidate"("materialId", "reviewStatus");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SentenceCandidate_materialId_chunkId_sentenceText_key" ON "SentenceCandidate"("materialId", "chunkId", "sentenceText");`,
  `CREATE INDEX IF NOT EXISTS "MaterialExerciseSet_materialId_isActive_idx" ON "MaterialExerciseSet"("materialId", "isActive");`,
  `CREATE INDEX IF NOT EXISTS "GeneratedExercise_materialId_type_reviewStatus_idx" ON "GeneratedExercise"("materialId", "type", "reviewStatus");`,
  `CREATE INDEX IF NOT EXISTS "GeneratedExercise_setId_idx" ON "GeneratedExercise"("setId");`,
  `CREATE INDEX IF NOT EXISTS "GeneratedExercise_materialId_dedupeKey_idx" ON "GeneratedExercise"("materialId", "dedupeKey");`,
  `CREATE INDEX IF NOT EXISTS "ExerciseAttempt_materialId_createdAt_idx" ON "ExerciseAttempt"("materialId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ExerciseAttempt_exerciseId_idx" ON "ExerciseAttempt"("exerciseId");`,
  `CREATE INDEX IF NOT EXISTS "ExerciseAttempt_setId_idx" ON "ExerciseAttempt"("setId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPack_materialId_key" ON "MaterialPack"("materialId");`,
  `CREATE INDEX IF NOT EXISTS "MaterialPack_materialId_idx" ON "MaterialPack"("materialId");`,
  `CREATE INDEX IF NOT EXISTS "MaterialPackItem_packId_sortOrder_idx" ON "MaterialPackItem"("packId", "sortOrder");`,
  `CREATE INDEX IF NOT EXISTS "MaterialPackItem_itemType_refId_idx" ON "MaterialPackItem"("itemType", "refId");`,
  `CREATE INDEX IF NOT EXISTS "TaskProposal_materialId_status_idx" ON "TaskProposal"("materialId", "status");`,
  `CREATE INDEX IF NOT EXISTS "TaskProposal_status_baseDate_idx" ON "TaskProposal"("status", "baseDate");`,
  `CREATE INDEX IF NOT EXISTS "TaskProposalItem_proposalId_suggestedDate_idx" ON "TaskProposalItem"("proposalId", "suggestedDate");`,
  `CREATE INDEX IF NOT EXISTS "TaskProposalItem_planTaskId_idx" ON "TaskProposalItem"("planTaskId");`,
];

/**
 * 既有表的唯一改动（架构文档 §2.9 / ADR-06）。
 *
 * SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，因此执行时先用 PRAGMA table_info 判断；
 * checksum 始终基于这份「规范语句清单」，与库里实际是否需要执行无关。
 */
const ALTERED_TABLE = 'AICallLog';
const ALTERED_COLUMNS = [
  { name: 'materialId', type: 'TEXT' },
  { name: 'materialJobId', type: 'TEXT' },
];
const ALTER_STATEMENTS = [
  ...ALTERED_COLUMNS.map(
    (column) => `ALTER TABLE "${ALTERED_TABLE}" ADD COLUMN "${column.name}" ${column.type};`,
  ),
  `CREATE INDEX IF NOT EXISTS "${ALTERED_TABLE}_materialId_idx" ON "${ALTERED_TABLE}"("materialId");`,
];

/** 受保护表：行数必须零漂移（AICallLog 允许只增不减，见 checkDrift）。 */
const PROTECTED_TABLES = [
  'PlanTask',
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法：node scripts/migrations/v2.6.mjs [--db <路径>] [--dry-run] [--allow-no-backup]

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
  for (const previous of PREVIOUS_VERSIONS) {
    const registered = query(opts.db, `SELECT count(*) FROM "AppMigration" WHERE version='${previous}';`) === '1';
    if (!registered) throw new Error(`尚未登记 ${previous}：请先运行 scripts/migrations/${previous}.mjs`);
  }

  const usingLiveDb = path.resolve(opts.db) === path.resolve(DEFAULT_DB);
  if (usingLiveDb && !opts.allowNoBackup) {
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : [];
    const hasBackup = files.some((name) => /^dev\.db\.before-/.test(name) || /^dev-.*\.db$/.test(name));
    if (!hasBackup) {
      throw new Error('升级真实库前必须先备份：bash scripts/backup.sh（或先跑副本演练）');
    }
  }

  const canonicalSql = [
    CREATE_TABLES.join('\n--\n'),
    '===',
    CREATE_INDEXES.join('\n'),
    '===',
    ALTER_STATEMENTS.join('\n'),
  ].join('\n');
  const checksum = createHash('sha256').update(canonicalSql).digest('hex').slice(0, 16);

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
  } else if (tableExists(opts.db, 'LearningMaterial')) {
    // 已存在 LearningMaterial 但未登记 v2.6：说明库被别的方式改过，禁止盲跑
    throw new Error('检测到 LearningMaterial 表已存在但 AppMigration 无 v2.6 记录：请先核对库结构来源');
  }

  const existingAlterColumns = tableColumns(opts.db, ALTERED_TABLE);
  if (!existingAlterColumns.size) throw new Error(`缺少 ${ALTERED_TABLE} 表：库结构异常`);
  const pendingAlterColumns = ALTERED_COLUMNS.filter((column) => !existingAlterColumns.has(column.name));

  const before = snapshotCounts(opts.db, [...CORE_TABLES, ...NEW_TABLES]);

  const transactionSql = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    // CREATE_TABLES 的多行 DDL 不带分号（与 prisma 生成物一致），这里统一补终止符
    ...CREATE_TABLES.map((sql) => `${sql};`),
    ...pendingAlterColumns.map(
      (column) => `ALTER TABLE "${ALTERED_TABLE}" ADD COLUMN "${column.name}" ${column.type};`,
    ),
    ...CREATE_INDEXES,
    `CREATE INDEX IF NOT EXISTS "${ALTERED_TABLE}_materialId_idx" ON "${ALTERED_TABLE}"("materialId");`,
    `INSERT INTO "AppMigration" ("id","version","checksum","note") VALUES ('appmig-v2.6','${VERSION}','${checksum}','纯加法：材料域 17 表 + AICallLog 2 可空列（Smart Learning Materials）') ON CONFLICT("version") DO NOTHING;`,
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    log(opts, `== v2.6 迁移预演（dry-run）==\n数据库：${opts.db}`);
    log(opts, `版本：${VERSION}　校验和：${checksum}　已登记：${alreadyApplied ? '是' : '否'}`);
    log(opts, `将新建表：${NEW_TABLES.length} 张 → ${NEW_TABLES.join(', ')}`);
    log(opts, `将新建索引：${CREATE_INDEXES.length} 个（另加 ${ALTERED_TABLE}_materialId_idx）`);
    log(
      opts,
      `将新增列：${pendingAlterColumns.length ? pendingAlterColumns.map((c) => `${ALTERED_TABLE}.${c.name}`).join(', ') : `（均已存在）${ALTERED_TABLE}.materialId / materialJobId`}`,
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
  const missingIndexes = CREATE_INDEXES.map((sql) => /"([^"]+_idx|[^"]+_key)"/.exec(sql)?.[1]).filter(
    (name) => !name || query(opts.db, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='${name}';`) !== '1',
  );
  const finalAlterColumns = tableColumns(opts.db, ALTERED_TABLE);
  const missingColumns = ALTERED_COLUMNS.filter((column) => !finalAlterColumns.has(column.name)).map(
    (column) => `${ALTERED_TABLE}.${column.name}`,
  );

  const protectedDrift = PROTECTED_TABLES.map((table) => checkDrift(table, before[table], after[table])).filter(
    (item) => item !== null,
  );

  const ok =
    integrity === 'ok' &&
    fkRows === '' &&
    missingTables.length === 0 &&
    missingIndexes.length === 0 &&
    missingColumns.length === 0 &&
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
    newIndexes: CREATE_INDEXES.length + 1,
    alteredColumns: ALTERED_COLUMNS.map((column) => `${ALTERED_TABLE}.${column.name}`),
    missingTables,
    missingIndexes,
    missingColumns,
    before,
    after,
    protectedDrift,
    ok,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `v2.6-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log(opts, `== v2.6 迁移${ok ? '完成' : '校验失败'} ==`);
  log(opts, `数据库：${opts.db}`);
  log(opts, `版本：${VERSION}　校验和：${checksum}　${alreadyApplied ? '（此前已登记，本次幂等重跑）' : '（首次登记）'}`);
  log(opts, `耗时：${durationMs} ms　integrity_check=${integrity}　外键违规=${report.foreignKeyViolations}`);
  log(opts, `新增表：${NEW_TABLES.length} 张（缺失 ${missingTables.length}）　新增索引：${report.newIndexes} 个（缺失 ${missingIndexes.length}）`);
  log(opts, `新增列：${report.alteredColumns.join(', ')}（缺失 ${missingColumns.length}）`);
  log(opts, `受保护表行数漂移：${protectedDrift.length}${protectedDrift.length ? ` → ${protectedDrift.join('; ')}` : ''}`);
  log(opts, `报告：${path.relative(ROOT, reportPath)}`);

  if (!ok) {
    console.error('校验未通过，请用备份回滚：bash scripts/restore.sh <backup>');
    process.exitCode = 1;
  }
}

main();
