/**
 * v2.4.1 诊断域常量与类型。
 *
 * 只放诊断专用枚举/阈值；通用证据与 AI 常量仍在 `src/lib/constants.ts`。
 */

export const DIAGNOSTIC_BLUEPRINT_CODE = 'diag-core';
export const DIAGNOSTIC_BLUEPRINT_VERSION = '1.0';

export const DIAGNOSTIC_SKILLS = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'GRAMMAR',
  'VOCABULARY',
  'SENTENCE_STRUCTURE',
  'EMLR',
] as const;
export type DiagnosticSkill = (typeof DIAGNOSTIC_SKILLS)[number];

export const DIAGNOSTIC_SKILL_LABEL_ZH: Record<DiagnosticSkill, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  GRAMMAR: '语法（辅助）',
  VOCABULARY: '词汇（辅助）',
  SENTENCE_STRUCTURE: '句子结构（辅助）',
  EMLR: '英语媒介学习准备度（可选）',
};

/** 四项核心技能：分别出画像，绝不平均成总体等级。 */
export const DIAGNOSTIC_CORE_SKILLS: DiagnosticSkill[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
];

export const DIAGNOSTIC_AUX_SKILLS: DiagnosticSkill[] = [
  'GRAMMAR',
  'VOCABULARY',
  'SENTENCE_STRUCTURE',
];

/** 等级序列（Pre-A1 是系统内部描述，不是官方 A0 等级）。 */
export const DIAG_LEVELS = ['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1'] as const;
export type DiagLevel = (typeof DIAG_LEVELS)[number];

export function levelIndex(level: string): number {
  const index = DIAG_LEVELS.indexOf(level as DiagLevel);
  return index >= 0 ? index : 0;
}

/** 题目目标难度 1–4 对应的参考等级；只用于画像换算，不是官方等级声明。 */
export const DIFFICULTY_LEVEL: Record<number, DiagLevel> = {
  1: 'A1',
  2: 'A2',
  3: 'B1',
  4: 'B2',
};

export const DIAG_TASK_TYPES = ['MCQ', 'SHORT_ANSWER', 'OPEN_TASK'] as const;
export type DiagTaskType = (typeof DIAG_TASK_TYPES)[number];

export const DIAG_SOURCE_TYPES = ['VERIFIED', 'RUBRIC', 'AI_PRACTICE'] as const;
export type DiagSourceType = (typeof DIAG_SOURCE_TYPES)[number];

export const DIAG_SOURCE_TYPE_LABEL_ZH: Record<DiagSourceType, string> = {
  VERIFIED: '已验证题库（有标准答案）',
  RUBRIC: '评分规准任务（有版本化 rubric）',
  AI_PRACTICE: 'AI 临时生成（仅练习，不作为定级唯一证据）',
};

export const DIAG_SESSION_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'PAUSED',
  'FINALIZING',
  'COMPLETED',
  'FAILED',
] as const;
export type DiagSessionStatus = (typeof DIAG_SESSION_STATUSES)[number];

export const DIAG_SESSION_STATUS_LABEL_ZH: Record<DiagSessionStatus, string> = {
  CREATED: '待开始',
  IN_PROGRESS: '进行中',
  PAUSED: '已暂停',
  FINALIZING: '正在生成报告',
  COMPLETED: '已完成',
  FAILED: '失败',
};

export const DIAG_ATTEMPT_STATUSES = [
  'SUBMITTED',
  'PENDING_EVAL',
  'SCORED',
  'INVALID',
  'NEEDS_REVIEW',
] as const;
export type DiagAttemptStatus = (typeof DIAG_ATTEMPT_STATUSES)[number];

export const DIAG_ATTEMPT_STATUS_LABEL_ZH: Record<DiagAttemptStatus, string> = {
  SUBMITTED: '已提交',
  PENDING_EVAL: '待评估',
  SCORED: '已评分',
  INVALID: '技术无效（不计分）',
  NEEDS_REVIEW: '待人工/补测',
};

/** 每个技能最多做几道客观题（含升降难度），防止无限追题。 */
export const DIAG_MAX_ATTEMPTS_PER_SKILL = 2;

/** 置信度阈值：样本数达到这些值且结果一致时才允许相应的置信度。 */
export const DIAG_SAMPLES_MEDIUM = 2;
export const DIAG_SAMPLES_HIGH = 3;

/** 开放式作答低于此词数视为样本不足，需要补测。 */
export const DIAG_MIN_WORDS_OPEN = 20;

/** 可信度标签（产品内部标签，不是统计学概率）。 */
export const DIAG_CONFIDENCE_LABEL_ZH = {
  LOW: '低（仅给范围，建议补测）',
  MEDIUM: '中（主要结论有依据，部分维度待补）',
  HIGH: '高（样本充足且结果一致）',
} as const;

/** 报告状态。 */
export const DIAG_REPORT_STATUSES = ['FINAL', 'PROVISIONAL', 'SUPERSEDED'] as const;
export type DiagReportStatus = (typeof DIAG_REPORT_STATUSES)[number];

export const DIAG_REPORT_STATUS_LABEL_ZH: Record<DiagReportStatus, string> = {
  FINAL: '正式（本轮证据完整）',
  PROVISIONAL: '暂定（证据不足，需补测）',
  SUPERSEDED: '已被新报告取代',
};

/** 诊断结果不是官方认证的固定声明。 */
export const DIAG_DISCLAIMER_ZH =
  '本结果为 AI 辅助的 CEFR 水平估计与能力画像，不是官方 CEFR 认证，也不预测 IELTS 分数。低置信度时只给范围，不强行定级。';

/** UI 中限制上传音频大小（data URL，约 1.5MB）。 */
export const DIAG_AUDIO_MAX_BYTES = 1_600_000;