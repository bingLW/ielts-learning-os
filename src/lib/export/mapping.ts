/**
 * 导出字段映射（Prisma camelCase → PRD 的 snake_case）。
 *
 * 只在导出层做映射，业务代码与库内字段保持一致，避免两套命名污染。
 */

/** 需要导出的表（14 核心 + 2 辅助）。 */
export const EXPORT_TABLES = [
  'userProfile',
  'stage',
  'stageAcceptanceItem',
  'planTask',
  'studySession',
  'studySessionDaySplit',
  'studyRecord',
  'recordRevision',
  'egiuLesson',
  'egiuReview',
  'mistake',
  'reviewTask',
  'vocabWord',
  'vocabQuiz',
  'vocabQuizItem',
  'sentenceAnalysis',
  'weeklyReview',
  'resource',
  'stageTransitionLog',
  'dailySummary',
  'aiSuggestion',
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

/** 表名 → CSV 文件名片段。 */
export const TABLE_FILE_NAME: Record<ExportTable, string> = {
  userProfile: 'user_profile',
  stage: 'stage',
  stageAcceptanceItem: 'stage_acceptance_item',
  planTask: 'plan_task',
  studySession: 'study_session',
  studySessionDaySplit: 'study_session_day_split',
  studyRecord: 'study_record',
  recordRevision: 'record_revision',
  egiuLesson: 'egiu_lesson',
  egiuReview: 'egiu_review',
  mistake: 'mistake',
  reviewTask: 'review_task',
  vocabWord: 'vocab_word',
  vocabQuiz: 'vocab_quiz',
  vocabQuizItem: 'vocab_quiz_item',
  sentenceAnalysis: 'sentence_analysis',
  weeklyReview: 'weekly_review',
  resource: 'resource',
  stageTransitionLog: 'stage_transition_log',
  dailySummary: 'daily_summary',
  aiSuggestion: 'ai_suggestion',
};

/** camelCase → snake_case（`planDate` → `plan_date`）。 */
export function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** 把一行的键名全部转成 snake_case。`Date` 统一转 ISO 字符串。 */
export function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[toSnakeCase(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** 批量映射。 */
export function mapRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => mapRow(row));
}

/** 校验表名是否合法。 */
export function isExportTable(value: string): value is ExportTable {
  return (EXPORT_TABLES as readonly string[]).includes(value);
}
