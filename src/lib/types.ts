/**
 * 跨层公共类型（DTO / 领域函数输入输出 / Action 返回值）。
 *
 * 硬约束：
 * 1. 所有业务枚举都是「字符串字面量联合类型」，真值集合在 `constants.ts` 中，
 *    两边由 `satisfies` 互相校验（见 constants.ts 末尾的静态断言区）。
 * 2. 这里出现的类型必须是「可序列化」的普通对象 —— 不允许 `Date`、`Prisma.Decimal`。
 *    时刻一律用 ISO 字符串，业务日期一律用 `YYYY-MM-DD` 字符串。
 */

import type {
  VocabDimension,
  VocabDimensionStatus,
  VocabIntegrationMode,
  VocabPracticeMode,
  VocabSessionGranularity,
} from './constants';

// ───────────────────────── 枚举联合类型 ─────────────────────────

/** EGIU（及语法点）三色判定结果。PENDING = 数据不足，不判定、不排程。 */
export type EgiuColor = 'PENDING' | 'GREEN' | 'YELLOW' | 'RED';

/** 复习任务状态。SUPERSEDED = 被更新的复习点取代（不删除，留痕）。 */
export type ReviewStatus = 'PENDING' | 'DONE' | 'SKIPPED' | 'SUPERSEDED';

/** 复习间隔档位。D0 是首测日，不是间隔。 */
export type IntervalCode =
  | 'D1'
  | 'D3'
  | 'D7'
  | 'D14'
  | 'D21'
  | 'D30'
  | 'MANUAL'
  | 'LOW_FREQ_30';

/** 复习目标类型：四类共用一个 `ReviewTask` 表，不允许各类型另建调度器。 */
export type TargetType = 'EGIU_LESSON' | 'MISTAKE' | 'VOCAB_WORD' | 'GRAMMAR_POINT';

/** 计划模块 ID（SOP 主线 9 项 + S0 基线 3 项 + v2 媒介学习 1 项 + v2.1 到期复习 1 项）。 */
export type ModuleId =
  | 'VOCAB_REVIEW'
  | 'GRAMMAR'
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'SENTENCE'
  | 'REVIEW_PLAN'
  | 'EXTENSIVE'
  | 'MEDIATED'
  | 'BASELINE_LISTEN'
  | 'BASELINE_READ'
  | 'BASELINE_OUTPUT'
  | 'P0_REVIEW'
  | 'EVIDENCE_RETEST';

/** 科目 ID。泛听泛读单独成桶，不并入精听/精读。 */
export type SkillId =
  | 'VOCAB'
  | 'GRAMMAR'
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'SENTENCE'
  | 'META'
  | 'LISTENING_EXT'
  | 'READING_EXT'
  | 'MEDIATED';

/**
 * 四项投入 + 泛练 + 语言知识 + 复盘 + 媒介学习，用于分钟数分桶聚合。
 *
 * `META` 是「复盘与计划」（`SkillId.META`）专用桶，**不并入任何科目**：
 * 听说读写四科分布图与 Dashboard 四项投入都不统计它（否则每天 10 分钟复盘
 * 会被算成句子成分，一周虚增 70 分钟）。
 *
 * `MEDIATED` 是 v2 的「英语媒介学习」桶，同样**不出现在四技能分布图**里 ——
 * 它代表的是「跨技能应用」的一段学习，不是第五项语言技能。它的时间在
 * 四技能口径下已经按 `StudySession.skill`（PrimarySkill）计入对应技能，
 * 这个桶只用于轨道视角的总量展示，**绝不参与四技能分母**。
 */
export type SkillBucket =
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'EXTENSIVE'
  | 'VOCAB'
  | 'GRAMMAR'
  | 'SENTENCE'
  | 'META'
  | 'MEDIATED';

/** 计划任务状态（7 态；v2.1 新增 CANCELLED / DEFERRED）。 */
export type TaskStatus =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIAL'
  | 'MISSED'
  | 'CANCELLED'
  | 'DEFERRED';

/** 计划任务优先级（v2.1）。P0 复习 > P1 阶段核心 > P2 弱项 > P3 拓展。 */
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** 任务来源分类（决定它在调度器里的默认优先级）。 */
export type TaskSourceKind =
  | 'REVIEW'
  | 'CORE'
  | 'WEAKNESS'
  | 'EXTENDED'
  | 'MANUAL'
  | 'LEGACY'
  /** v2.2：由到期 RetestSchedule 排入的证据复测；生成引擎只预留时间，不产出技能池任务。 */
  | 'RETEST';

/** 每日预算的创建来源。 */
export type BudgetSource = 'USER' | 'WEEKDAY_TEMPLATE' | 'DEFAULT_SUGGESTION' | 'MIGRATION';

/** 每日预算类型。 */
export type BudgetType = 'PRESET' | 'CUSTOM' | 'REST_DAY';

/** 时间档次编码（15 分钟起，240 分钟止，另含自定义与休息）。 */
export type BudgetTierCode =
  | 'EMERGENCY'
  | 'MINIMUM'
  | 'LIGHT'
  | 'LIGHT_STANDARD'
  | 'STANDARD'
  | 'FOCUSED'
  | 'DEEP'
  | 'EXTENDED'
  | 'CUSTOM'
  | 'REST';

/** 计划版本变更来源。 */
export type PlanChangeSource = 'GENERATE' | 'REPLAN' | 'MANUAL_ADJUST';

/** 计时器状态。唯一真值是服务端库里的这份状态，客户端只做展示。 */
export type TimerStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED';

/** 阶段编码。 */
export type StageCode = 'S0_PREP' | 'S1_A0_A2' | 'S2_A2_B1' | 'S3_B1_IELTS';

/** 阶段状态。同一时刻只允许一个 ACTIVE。 */
export type StageStatus = 'NOT_STARTED' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED';

/** 验收维度（每阶段 7 项）。 */
export type AcceptanceDimension =
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'GRAMMAR'
  | 'VOCAB'
  | 'SENTENCE';

/** 验收判定。 */
export type Verdict = 'PENDING' | 'PASSED' | 'FAILED';

/** 错题错误类别（6 类）。 */
export type ErrorCategory =
  | 'RULE_NOT_UNDERSTOOD'
  | 'MEMORY_CONFUSION'
  | 'VOCAB_UNKNOWN'
  | 'WORD_ORDER'
  | 'CARELESS'
  | 'OTHER';

/** 雅思题型错因子（仅 S3 启用）。 */
export type IeltsErrorCategory =
  | 'VOCAB'
  | 'LOCATING'
  | 'COMPREHENSION'
  | 'ATTENTION'
  | 'STRATEGY';

/** 词汇掌握度三档 —— 禁止合并成单一「已掌握」统计。 */
export type MasteryLevel = 'RECOGNIZE_ONLY' | 'COMPREHEND' | 'ACTIVE_USE';

/** 句子成分。与词性是**两个独立集合**，不得互相取值。 */
export type SentenceComponent = 'S' | 'V' | 'O' | 'C' | 'ADVERBIAL';

/** 词性。 */
export type PartOfSpeech = 'NOUN' | 'VERB' | 'ADJ' | 'ADV' | 'PREP' | 'PRON' | 'OTHER';

/** 句型标签。 */
export type PatternTag =
  | 'FIVE_PATTERNS'
  | 'RELATIVE_CLAUSE'
  | 'ADVERBIAL_CLAUSE'
  | 'NON_FINITE'
  | 'PASSIVE';

/** 难度。 */
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';

/** 计时段的结束原因。 */
export type TerminatedReason = 'COMPLETED' | 'PAUSED' | 'ABANDONED' | 'MOVED' | 'TIMEOUT';

/** 复习任务结果。 */
export type ReviewResult = 'PASS' | 'FAIL';

/** 阶段流转决策来源。 */
export type TransitionDecidedBy = 'SYSTEM_SUGGESTED' | 'USER';

// ───────────────────────── v2.0 三轨道 ─────────────────────────

/**
 * 学习轨道。任务必须归属一个主轨道；允许加标签，
 * 但**一条学习时长只能计入一次总时长**。
 */
export type LearningTrack = 'GENERAL_ENGLISH' | 'IELTS_PREPARATION' | 'ENGLISH_MEDIATED_LEARNING';

/**
 * 四技能粒度 + 支持性模块（`FOUNDATION`）。
 *
 * **这是技能时间统计的唯一维度**：`SkillMinutes(skill)` 只认这个字段。
 * `FOUNDATION`（词汇/语法/句子/复盘/泛练/媒介学习的支持部分）**不进四技能分母**。
 *
 * 与 `SkillId` 的区别：`SkillId` 是「计划模块粒度」（含泛听泛读、复盘），
 * 会进一步分桶成 `EXTENSIVE`/`META`；`PrimarySkill` 是「语言技能粒度」，只有 5 个值。
 */
export type PrimarySkill = 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING' | 'FOUNDATION';

/** 参与四技能配比分母的技能集合（顺序即展示顺序）。 */
export type AllocationSkill = 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING';

/** 阶段 profile 编码（SOP v2 §2）。 */
export type StageProfileCode = 'PREPARATION' | 'A0_A2' | 'A2_B1' | 'B1_B2' | 'IELTS_INTENSIVE';

/** 学习目标类型。 */
export type GoalType = 'GENERAL_ENGLISH' | 'IELTS' | 'ENGLISH_MEDIATED_LEARNING';

/** 目标状态。 */
export type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'PAUSED';

/** 里程碑状态。 */
export type MilestoneStatus = 'PENDING' | 'ACHIEVED' | 'FAILED';

/** CEFR 等级（个人能力估计，非官方认证）。 */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

/** 能力评估方式。 */
export type AssessmentType = 'SELF' | 'TEST' | 'EXTERNAL' | 'AI_ESTIMATE';

/** 评估者来源。 */
export type AssessorKind = 'SELF' | 'TEACHER' | 'EXAM' | 'AI' | 'OTHER';

/** IELTS 记录类型：正式考试 / 模考 / 单项练习。 */
export type IeltsTestType = 'OFFICIAL' | 'MOCK' | 'PRACTICE';

/** 英语媒介学习的理解情况。 */
export type MediatedUnderstanding = 'FULL' | 'PARTIAL' | 'LOW';

/** 英语媒介学习的翻译依赖程度（NONE 最好，HEAVY_ZH 最差）。 */
export type TranslationDependency = 'NONE' | 'SUBTITLE_EN' | 'ZH_ASSIST' | 'HEAVY_ZH';

/** 英语媒介学习的强度档（A2–B1 试学 / B1 后系统化）。 */
export type MediatedIntensity = 'PRE_A2' | 'A2_B1' | 'B1_PLUS';

/** 学习产出类型。 */
export type OutputType =
  | 'NOTE_EN'
  | 'SUMMARY_EN'
  | 'QUESTION_EN'
  | 'ESSAY'
  | 'RECORDING'
  | 'MINDMAP';

/** 证据附件类型。 */
export type EvidenceType =
  | 'RECORDING'
  | 'WRITING'
  | 'SCORE_SHEET'
  | 'COURSE_MATERIAL'
  | 'SCREENSHOT'
  | 'OTHER';

/** 证据可挂载的实体类型。 */
export type EvidenceEntity =
  | 'SKILL_ASSESSMENT'
  | 'IELTS_ASSESSMENT'
  | 'MEDIATED_SESSION'
  | 'STUDY_RECORD'
  | 'GOAL_MILESTONE';

// ───────────────────────── v2.0 DTO ─────────────────────────

/** 四技能配比（合计必须 100）。 */
export interface SkillAllocation {
  LISTENING: number;
  READING: number;
  SPEAKING: number;
  WRITING: number;
}

/** 配比校验结果。 */
export type AllocationCheck =
  | { ok: true; allocation: SkillAllocation; total: 100 }
  | { ok: false; code: 'SUM_NOT_100'; total: number; error: string }
  | { ok: false; code: 'NEGATIVE_OR_NAN'; error: string };

/** 四技能实际占比（分母 = 四项技能之和；分母为 0 → 全部 `null`）。 */
export interface SkillShareDto {
  /** 各技能分钟（只含四技能，不含 FOUNDATION）。 */
  minutes: SkillAllocation;
  /** 四技能分钟合计（= 分母）。 */
  denominator: number;
  /** 各技能占比 0..1；分母为 0 时为 `null`（展示 `—`，绝不补 0）。 */
  share: { LISTENING: number | null; READING: number | null; SPEAKING: number | null; WRITING: number | null };
  /** 支持性时间（FOUNDATION），单列，不进分母。 */
  foundationMinutes: number;
}

/** 单轨道统计。 */
export interface TrackStatDto {
  track: LearningTrack;
  labelZh: string;
  minutes: number;
  sessionCount: number;
  /** 占总净时长比例；总时长为 0 → `null`。 */
  shareOfTotal: number | null;
}

/** 一个目标的看板卡。 */
export interface GoalCardDto {
  goalType: GoalType;
  labelZh: string;
  status: GoalStatus;
  /** 目标描述（如「B2」「总分 6.5，单项 ≥6.0」）。 */
  targetText: string;
  /** 当前进展描述（如「B1（4 项技能中 2 项达 B1）」「最近模考 6.0」）。 */
  currentText: string;
  /** 0..1 的达成度；`null` = 证据不足（不显示假进度）。 */
  progress: number | null;
  /** 一行说明，必须写清「凭什么这么判断」。 */
  basis: string;
  /** 若未达成，列出未满足项。 */
  unmet: string[];
  href: string;
}

/** 媒介学习一次记录的 DTO。 */
export interface MediatedSessionDto {
  id: string;
  sessionDate: string;
  subject: string;
  topic: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourceType: string;
  primarySkill: PrimarySkill;
  durationMinutes: number;
  languageLevel: string | null;
  understanding: MediatedUnderstanding;
  translationDependency: TranslationDependency;
  notesEn: string | null;
  summaryEn: string | null;
  questionsEn: string | null;
  intensity: MediatedIntensity;
  /** 真实落库 session 的净分钟（与 `durationMinutes` 交叉校验）。 */
  actualNetMinutes: number;
  outputCount: number;
  /** 由本记录生成的证据 ID（一条记录最多一条，未生成时为 null）。 */
  evidenceId: string | null;
}

/** 能力评估行 DTO。 */
export interface SkillAssessmentDto {
  id: string;
  skill: AllocationSkill;
  cefrLevel: CefrLevel;
  assessmentType: AssessmentType;
  score: string | null;
  assessDate: string;
  assessor: AssessorKind;
  confidence: number;
  note: string | null;
}

/** IELTS 成绩行 DTO。 */
export interface IeltsAssessmentDto {
  id: string;
  testDate: string;
  testType: IeltsTestType;
  overallBand: number;
  listeningBand: number | null;
  readingBand: number | null;
  writingBand: number | null;
  speakingBand: number | null;
  source: string | null;
  notes: string | null;
}

// ───────────────────────── 通用返回值 ─────────────────────────

/** Action 失败码。UI 按码给文案，不解析 error 字符串做逻辑。 */
export type ActionErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION'
  | 'INTERNAL';

/**
 * 所有 Server Action 的统一返回类型。
 * 失败一律 **返回** 而非 throw —— Next 15 会把 throw 吞成 500，UI 拿不到可读信息。
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: ActionErrorCode;
      error: string;
      fieldErrors?: Record<string, string>;
    };

/** 领域函数的输入校验失败表达方式（domain 层不 throw，用返回值表达）。 */
export interface DomainError<TCode extends string> {
  ok: false;
  code: TCode;
}

// ───────────────────────── 领域函数类型 ─────────────────────────

/** EGIU 判定输入。`sentences` 是「独立造出的、正确的新句子数」。 */
export interface EgiuJudgeInput {
  total: number;
  correct: number;
  explainOK: boolean;
  sentences: number;
  coreRuleOK: boolean;
}

/** EGIU 判定输出。`score` 只在 LOW_VOLUME 分支出现。 */
export interface EgiuJudgment {
  color: EgiuColor;
  reason: string;
  branch: 'ZERO' | 'OVERRIDE' | 'FULL' | 'LOW_VOLUME';
  score?: number;
}

/** 一个待落库的复习点。 */
export interface PlannedPoint {
  intervalCode: IntervalCode;
  dueDate: string;
  estMinutes: number;
}

/** 库中已存在的复习点（用于去重与上限裁剪）。 */
export interface ExistingPoint {
  intervalCode: IntervalCode;
  dueDate: string;
  status: ReviewStatus;
}

/** 加权正确率样本。`total <= 0` 或 `null` 的样本必须被剔除，不是当 0 算。 */
export interface AccSample {
  total: number | null;
  correct: number | null;
  recordId?: string;
}

/**
 * 完成率计算的单条输入。
 *
 * `movedFromDate` / `movedToDate` 供 `isCountableForDate` 做「原日剔除、目标日计入」判断：
 * 调用方（`queries/plan.ts`）必须传真实值，否则顺延任务会在两个日期各被统计一次。
 */
export interface CompletionItem {
  plannedMinutes: number;
  actualMinutes: number;
  status: TaskStatus;
  movedToDate?: string | null;
  movedFromDate?: string | null;
}

/** 完成率结果。分母为 0 时返回 `null`（不是 0）。 */
export interface CompletionRate {
  byTime: number | null;
  byCount: number | null;
}

/** 计时段净时长计算输入。 */
export interface SessionLike {
  activeMinutes: number;
  plannedMinutes: number;
  startedAt: string;
  endedAt: string;
  idleMinutes: number;
}

/** 净时长计算结果。 */
export interface SessionNetResult {
  netMinutes: number;
  anomaly: boolean;
  reason?: string;
}

/** 日计划生成项。 */
export interface DailyPlanItem {
  module: ModuleId;
  skill: SkillId;
  minutes: number;
  sortOrder: number;
  /**
   * v2.0：本条任务归属的轨道。轨道是任务的**属性**，不是第二份记录 ——
   * 同一条时长不可能既属于通用英语又属于雅思备考。
   */
  track: LearningTrack;
  /**
   * v2.0：四技能粒度。四技能配比分母**只认这个字段**，不认 `skill`
   * （`skill` 是模块粒度，含泛听/泛读/复盘，混进去会污染分母）。
   */
  primarySkill: PrimarySkill;
}

/** 薄弱项提示（已把子项映射到父模块）。 */
export interface WeakModuleHint {
  module: ModuleId;
  weight: number;
}

/** 阶段门禁结果。 */
export interface GateUnmetItem {
  code: 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
  label: string;
  current: string;
  target: string;
}

export interface GateResult {
  suggested: boolean;
  unmet: GateUnmetItem[];
  metrics: {
    requiredPassed: number;
    requiredTotal: number;
    h3Rate: number | null;
    h4Rate: number | null;
    redLessons: number;
  };
}

// ───────────────────────── 读模型 DTO ─────────────────────────
// 所有 DTO 都是「已算好的普通对象」，Prisma 原始 model 不出 Server。

/** 计划任务行 DTO（计划页列表视图用）。 */
export interface PlanTaskDto {
  id: string;
  module: ModuleId;
  moduleLabel: string;
  skill: SkillId;
  track: LearningTrack;
  primarySkill: PrimarySkill;
  plannedMinutes: number;
  actualMinutes: number;
  sortOrder: number;
  status: TaskStatus;
  /** 已顺延次数（上限 2，超出提示下调计划时长）。 */
  movedCount: number;
  resourceId: string | null;
  resourceName: string | null;
  note: string | null;
  timerStatus: TimerStatus;
  timerStartedAt: string | null;
  timerAccumulatedSeconds: number;
  timerVersion: number;
  /** v2.1 优先级（P0 到期复习 / P1 阶段核心 / P2 弱项 / P3 拓展）。 */
  priority: TaskPriority;
  /** 是否允许分段执行。 */
  splittable: boolean;
  /** 生成/重排时的计划版本。 */
  planVersion: number;
  /** 首次被安排到的日期（顺延、重排后不变）。 */
  originalScheduledDate: string | null;
  /** 任务来源（复习 / 核心 / 弱项 / 拓展 / 手动 / v2.0 旧数据）。 */
  sourceKind: TaskSourceKind;
  /** 延期原因（重排或手动延后时写入）。 */
  deferReason: string | null;
}

/** 计划页顶部的时间预算条（v2.1）。 */
export interface PlanBudgetDto {
  /** 当日有效预算分钟。 */
  minutes: number;
  isRestDay: boolean;
  /** 预算来源：用户设定 / 星期模板 / 未确认的建议值。 */
  source: BudgetSource;
  /** true = 这只是系统建议，不是用户确认过的可用时间。 */
  isSuggestion: boolean;
  tierCode: string | null;
}

/** 计划页整体 DTO。 */
export interface PlanPageDto {
  planDate: string;
  stageId: string | null;
  stageCode: StageCode | null;
  stageName: string | null;
  totalPlannedMinutes: number;
  totalActualMinutes: number;
  grammarPlannedMinutes: number;
  grammarCapMinutes: number;
  grammarOverCap: boolean;
  tasks: PlanTaskDto[];
  completion: CompletionRate;
  netMinutes: number;
  dailySummary: DailySummaryDto | null;
  availableResources: ResourceOptionDto[];
  /** v2.1：当日有效预算与来源。 */
  budget: PlanBudgetDto;
  /** 当日计划版本数（>1 表示重排过）。 */
  planVersionCount: number;
  /** v2.2：当日计划中计入预算的证据复测分钟（module = EVIDENCE_RETEST）。 */
  retestPlannedMinutes: number;
}

export interface DailySummaryDto {
  summaryDate: string;
  netMinutes: number;
  draftText: string | null;
  completionRateByTime: number | null;
  completionRateByCount: number | null;
}

/** 周报「预算 vs 实际」模块（v2.1）。 */
export interface WeeklyBudgetDto {
  /** 本周逐日：有效预算 / 是否休息日 / 实际净时长 / 计划分钟。 */
  days: {
    date: string;
    budgetMinutes: number;
    isRestDay: boolean;
    /** 预算是用户设定还是模板/建议值。 */
    source: BudgetSource;
    isSuggestion: boolean;
    netMinutes: number;
    plannedMinutes: number;
  }[];
  /** 本周预算合计（休息日计 0）。 */
  budgetTotalMinutes: number;
  /** 本周实际净时长合计。 */
  netTotalMinutes: number;
  /** 非休息日且预算>0 的天数（用于日均口径）。 */
  budgetedDays: number;
  /** 休息日天数。 */
  restDays: number;
  /** 本周计划版本变更次数（>0 表示中途重排过）。 */
  replanCount: number;
  /** 重排明细（时间、来源、预算、原因）。 */
  versions: {
    version: number;
    changeSource: string;
    budgetMinutes: number;
    reason: string | null;
    createdAt: string;
  }[];
  /** 周目标（若设置过）。 */
  target: { targetMinutes: number; status: string; source: string } | null;
}

/** 资源下拉选项（数据驱动，代码中无资源名枚举）。 */
export interface ResourceOptionDto {
  id: string;
  name: string;
  subject: string;
  type: string;
  isPrimary: boolean;
}

/** 资源表格行 DTO。 */
export interface ResourceRowDto {
  id: string;
  name: string;
  subject: string;
  subjectLabel: string;
  type: string;
  typeLabel: string;
  applicableStages: string[];
  version: string | null;
  totalUnits: number | null;
  currentUnit: number | null;
  progressPercent: number | null;
  startDate: string | null;
  finishDate: string | null;
  url: string | null;
  note: string | null;
  isPrimary: boolean;
}

/** 学习记录行 DTO。 */
export interface StudyRecordRowDto {
  id: string;
  recordDate: string;
  skill: SkillId;
  skillLabel: string;
  track: LearningTrack;
  primarySkill: PrimarySkill;
  content: string;
  chapter: string | null;
  resourceName: string | null;
  plannedMinutes: number;
  actualMinutes: number;
  totalQuestions: number;
  correctQuestions: number;
  accuracy: number | null;
  status: TaskStatus;
  difficulty: Difficulty | null;
  hasOutput: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 学习记录详情 DTO（编辑表单回填用）。 */
export interface StudyRecordDetailDto extends StudyRecordRowDto {
  stageId: string;
  taskId: string | null;
  resourceId: string | null;
  outputText: string | null;
  problemText: string | null;
  errorTypes: string[];
  nextReviewDate: string | null;
  ext: Record<string, unknown>;
}

/** 修订历史行 DTO。 */
export interface RevisionRowDto {
  id: string;
  field: string;
  fieldLabel: string;
  beforeValue: string | null;
  afterValue: string | null;
  changedAt: string;
}

/** Dashboard 单块统计用的纯量输入。 */
export interface DashboardZoneDto {
  plannedMinutes: number;
  netMinutes: number;
  effectiveOutputs: number;
  greenRatio: number | null;
}

/** 趋势点：空缺日 `minutes = null`（折线断点，不补 0）。 */
export interface TrendPointDto {
  date: string;
  minutes: number | null;
}

/** 复习债务统计。 */
export interface ReviewDebtDto {
  dueToday: number;
  overdue: number;
  next7Days: number;
  overdueItems: { id: string; label: string; intervalCode: string; overdueDays: number }[];
}

/** EGIU 三色分布（按 Lesson 最新判定去重后计数）。 */
export interface ColorDistributionDto {
  GREEN: number;
  YELLOW: number;
  RED: number;
  PENDING: number;
}

/** 薄弱点 Top3。 */
export interface WeaknessDto {
  name: string;
  score: number;
  evidence: string;
  actionHint: string;
}

/** 阶段门禁区 DTO。 */
export interface GatePanelDto {
  stageId: string;
  stageCode: StageCode;
  stageName: string;
  gate: GateResult;
}

/** 当前阶段状态条 DTO。 */
export interface StatusStripDto {
  stageName: string;
  stageCode: StageCode;
  startedAt: string | null;
  elapsedDays: number;
  estDaysMin: number;
  estDaysMax: number | null;
  remainDays: number | null;
  overrunDays: number;
  targetBand: number;
}

/** 词汇三档分布。 */
export interface MasteryDistributionDto {
  RECOGNIZE_ONLY: number;
  COMPREHEND: number;
  ACTIVE_USE: number;
  total: number;
  quizAccuracy: number | null;
}

/**
 * 四项投入分钟数（+ 泛练 + 语言知识 + 复盘）。
 *
 * `SKILL_BUCKET_ORDER`（四科图表 / Dashboard 四项投入的展示顺序）**不含** `META`：
 * 复盘时间只在这个 DTO 里保留原始值，绝不并入听说读写任何一科。
 */
export interface SkillInvestmentDto {
  LISTENING: number;
  READING: number;
  SPEAKING: number;
  WRITING: number;
  EXTENSIVE: number;
  VOCAB: number;
  GRAMMAR: number;
  SENTENCE: number;
  /** 复盘与计划（独立成桶，不计入四科、不进四科分布图）。 */
  META: number;
  /**
   * 英语媒介学习（跨技能应用，独立成桶）。
   * 它的时长在四技能口径下已按 PrimarySkill 计入对应技能，**此桶不进四技能分母**。
   */
  MEDIATED: number;
}

/** Dashboard 全量 DTO —— 12 个区块的唯一数据来源，全部来自数据库聚合。 */
export interface DashboardDto {
  statusStrip: StatusStripDto | null;
  zones: {
    today: DashboardZoneDto;
    week: DashboardZoneDto;
  };
  today: {
    planDate: string;
    completionByTime: number | null;
    completionByCount: number | null;
    doneTasks: number;
    totalTasks: number;
    remainingMinutes: number;
    nextTask: { id: string; label: string; plannedMinutes: number } | null;
  };
  week: {
    weekStart: string;
    weekEnd: string;
    netMinutes: number;
    completionByTime: number | null;
    prevNetMinutes: number;
    netDelta: number;
  };
  skillInvestment: SkillInvestmentDto;
  /**
   * 四技能配比对比（v2.0）：实际 vs 当前阶段建议。
   * `target` 为 `null` 表示阶段没有内置配比（如 IELTS_INTENSIVE 需用户配置），
   * 此时页面只展示实际占比，不展示偏离。
   */
  allocation: {
    minutes: SkillAllocation & { FOUNDATION: number };
    target: SkillAllocation | null;
    profileCode: StageProfileCode | null;
  };
  grammarVocab: {
    colors: ColorDistributionDto;
    redUnhandled: number;
    vocabTotal: number;
    vocabNewThisWeek: number;
    mastery: MasteryDistributionDto;
  };
  reviewDebt: ReviewDebtDto;
  trend7: TrendPointDto[];
  trend30: TrendPointDto[];
  weakness: { ranked: WeaknessDto[]; insufficient: WeaknessDto[]; dataDays: number };
  gate: GatePanelDto | null;
  dataDays: number;
}

/** 阶段页 DTO（时间线 + 验收清单）。 */
export interface StageTimelineItemDto {
  id: string;
  code: StageCode;
  nameZh: string;
  estDaysMin: number;
  estDaysMax: number | null;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  elapsedDays: number;
  passedCount: number;
  requiredTotal: number;
  isActive: boolean;
}

export interface AcceptanceItemDto {
  id: string;
  dimension: AcceptanceDimension;
  dimensionLabel: string;
  isRequired: boolean;
  criterionText: string;
  myResult: string | null;
  evidence: string | null;
  verdict: Verdict;
  judgedAt: string | null;
}

/** 导出载荷。 */
export interface ExportPayload {
  schema_version: number;
  exported_at: string;
  timezone: string;
  counts: Record<string, number>;
  data: Record<string, unknown[]>;
}

// ═════════════════════════ 阶段 C / D ═════════════════════════
// 说明：下面这些枚举的**真值集合**在 `constants.ts`（数组元组），
// 类型定义放在这里，因为 `types.ts` 是 DTO 的唯一来源，而 `constants.ts`
// 本来就反向依赖 `types.ts`（只依赖类型，运行期无循环）。

/** EGIU 复测档位。`D0` 是首测日，不是复习间隔。 */
export type ReviewStageCode = 'D0' | 'D1' | 'D3' | 'D7' | 'D14' | 'D21' | 'D30' | 'MANUAL';

/** EGIU 判定命中的分支（`EgiuReview.judgeBranch`）。 */
export type JudgeBranch = 'ZERO' | 'OVERRIDE' | 'FULL' | 'LOW_VOLUME';

/** 错题来源。 */
export type MistakeSource = 'EGIU_REVIEW' | 'STUDY_RECORD' | 'MANUAL' | 'VOCAB';

/** 周复盘 13 项指标键。 */
export type WeeklyMetricKey =
  | 'NET_MINUTES'
  | 'DAILY_DISTRIBUTION'
  | 'COMPLETION_RATE'
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'GRAMMAR'
  | 'COLOR_DELTA'
  | 'MISTAKES'
  | 'VOCAB'
  | 'TOP_ERROR_CATEGORY'
  | 'WEEK_OVER_WEEK';

/** 全局筛选参数键（只允许这几个出现在 URL 上）。 */
export type GlobalFilterKey = 'from' | 'to' | 'stageId' | 'skill' | 'resourceId';

/** AI 建议作用域。 */
export type AiScope = 'WEAKNESS' | 'WEEKLY' | 'PLAN';

/** AI 建议状态。`available`=已生成，`unavailable`=未生成。 */
export type AiStatus = 'available' | 'unavailable';

/** 批量复习操作。 */
export type BatchReviewOp = 'COMPLETE_PASS' | 'POSTPONE';

/** 领域导出类别（T33：grammar / mistakes / vocab / sentences / reviews）。 */
export type DomainExportKind = 'grammar' | 'mistakes' | 'vocab' | 'sentences' | 'reviews';

// ───────────────────────── T24 / T28 复习任务 ─────────────────────────

/** 复习任务行 DTO（`ReviewTask` 的读模型，逾期天数由服务端算好）。 */
export interface ReviewTaskRowDto {
  id: string;
  targetType: TargetType;
  targetTypeLabel: string;
  targetId: string;
  targetLabel: string;
  knowledgePoint: string | null;
  intervalCode: IntervalCode;
  intervalLabel: string;
  dueDate: string;
  status: ReviewStatus;
  estMinutes: number;
  result: ReviewResult | null;
  completedAt: string | null;
  /** 逾期天数（0 = 今天到期，负数不会出现：未到期即 false）。 */
  overdueDays: number;
  isOverdue: boolean;
}

/** 复习中心分桶键。 */
export type ReviewBucketKey = 'OVERDUE' | 'TODAY' | 'WEEK';

export interface ReviewBucketDto {
  key: ReviewBucketKey;
  title: string;
  hint: string;
  items: ReviewTaskRowDto[];
  estMinutes: number;
}

/** 复习中心聚合视图（按 dueDate 分组：逾期 / 今日 / 本周）。 */
export interface ReviewCenterDto {
  today: string;
  overdueCount: number;
  dueTodayCount: number;
  weekCount: number;
  totalEstMinutes: number;
  dailyMinutes: number;
  /** 预估复习分钟 > 可用时长 25% → true（提示但不截断）。 */
  loadHeavy: boolean;
  buckets: ReviewBucketDto[];
  /** 已掌握并进入 30 天低频池的点，只展示不可操作。 */
  lowFreq: ReviewTaskRowDto[];
}

// ───────────────────────── T21 / T22 / T23 EGIU ─────────────────────────

/** EGIU 单元行 DTO。 */
export interface EgiuLessonRowDto {
  id: string;
  stageId: string;
  unitNo: string;
  knowledgePoint: string;
  book: string;
  version: string | null;
  currentColor: EgiuColor;
  currentScore: number | null;
  currentReason: string | null;
  /** D0 首测日，复习点起算日。 */
  learnedDate: string;
  greenStreak: number;
  mastered: boolean;
  masteredAt: string | null;
  inLowFreqPool: boolean;
  nextReviewDate: string | null;
  retestCount: number;
  resourceId: string | null;
  resourceName: string | null;
  pendingReviewCount: number;
  overdueReviewCount: number;
}

/** 错因分布（`EgiuReview.errorBreakdown` 的读模型）。 */
export interface EgiuErrorBreakdownDto {
  ruleUnclear: number;
  memoryConfusion: number;
  careless: number;
  vocab: number;
}

/** EGIU 复测记录行 DTO（append-only，永不可编辑）。 */
export interface EgiuReviewRowDto {
  id: string;
  reviewDate: string;
  reviewStage: ReviewStageCode;
  reviewStageLabel: string;
  totalQuestions: number;
  correctQuestions: number;
  accuracy: number | null;
  explainOk: boolean;
  sentencesCount: number;
  coreRuleOk: boolean;
  judgedColor: EgiuColor;
  judgeReason: string;
  judgeBranch: JudgeBranch;
  judgeBranchLabel: string;
  score: number | null;
  errorBreakdown: EgiuErrorBreakdownDto | null;
  reviewTaskId: string | null;
  createdAt: string;
}

/** 「掌握度变化」时间线条目（复测序列 → 颜色迁移）。 */
export interface EgiuMasteryChangeDto {
  label: string;
  fromColor: EgiuColor | null;
  toColor: EgiuColor;
  changedAt: string;
  note: string;
}

/** EGIU 单元详情 DTO。 */
export interface EgiuLessonDetailDto {
  lesson: EgiuLessonRowDto;
  stageId: string;
  reviews: EgiuReviewRowDto[];
  upcoming: ReviewTaskRowDto[];
  masteryChanges: EgiuMasteryChangeDto[];
  /** 当前阶段是否允许做 EGIU 判定（S0 / S3 为 false）。 */
  egiuAllowed: boolean;
  /** 掌握度说明（例如「连续 2 次绿灯且间隔 ≥7 天」）。 */
  masteryNote: string;
}

/** EGIU 判定预览（客户端与 action 共用同一份纯函数结果）。 */
export interface EgiuJudgePreviewDto {
  color: EgiuColor;
  reason: string;
  branch: JudgeBranch;
  score: number | null;
  /** 本次判定将生成的复习档位（GREEN → 空数组）。 */
  intervals: IntervalCode[];
}

// ───────────────────────── T25 错题 ─────────────────────────

/** 错题行 DTO。 */
export interface MistakeRowDto {
  id: string;
  stageId: string;
  sourceType: MistakeSource;
  sourceLabel: string;
  studyRecordId: string | null;
  originalQuestion: string;
  myAnswer: string | null;
  correctAnswer: string;
  errorReason: string;
  knowledgePoint: string;
  errorCategory: ErrorCategory;
  errorCategoryLabel: string;
  ieltsErrorCategory: IeltsErrorCategory | null;
  ieltsErrorCategoryLabel: string | null;
  reviewCount: number;
  lastReviewAt: string | null;
  nextReviewAt: string | null;
  isMastered: boolean;
  createdAt: string;
}

/** 错题页筛选态（与 URL searchParams 一一对应）。 */
export interface MistakeFilterState {
  q: string;
  errorCategory: ErrorCategory | 'ALL';
  knowledgePoint: string;
  mastery: 'ALL' | 'MASTERED' | 'UNMASTERED';
  from: string;
  to: string;
  stageId: string;
}

/** 错题统计（列表页顶部 + 图表数据源）。 */
export interface MistakeStatsDto {
  total: number;
  mastered: number;
  pendingReviewTask: number;
  byCategory: { category: ErrorCategory; label: string; count: number }[];
  topKnowledgePoints: { name: string; count: number }[];
}

// ───────────────────────── T26 词汇 ─────────────────────────

/** 词汇行 DTO。三档掌握度各自独立计数，绝不合并。 */
export interface VocabWordRowDto {
  id: string;
  word: string;
  phonetic: string | null;
  partOfSpeech: string | null;
  meaningZh: string;
  meaningEn: string | null;
  collocation: string | null;
  exampleSentence: string | null;
  source: string;
  learnedDate: string;
  mastery: MasteryLevel;
  masteryLabel: string;
  lastReviewAt: string | null;
  nextReviewAt: string | null;
  isNew: boolean;
}

/** 词汇页统计 + 下周新词量建议。 */
export interface VocabStatsDto {
  total: number;
  recognizeOnly: number;
  comprehend: number;
  activeUse: number;
  newThisWeek: number;
  reviewDueToday: number;
  quizAccuracy: number | null;
  quizCount: number;
  suggestedNewWords: number;
  suggestionReason: string;
}

/** 抽测条目 DTO。 */
export interface VocabQuizItemDto {
  id: string;
  wordId: string | null;
  word: string;
  selfRating: MasteryLevel;
  weight: number;
}

/** 抽测会话 DTO（append-only）。 */
export interface VocabQuizDto {
  id: string;
  quizDate: string;
  sampleSize: number;
  weightedAccuracy: number | null;
  recommendation: string | null;
  createdAt: string;
  items: VocabQuizItemDto[];
}

/** 抽测提交项（客户端 → action）。 */
export interface VocabQuizAnswerDto {
  wordId: string;
  selfRating: MasteryLevel;
}

// ───────────────────────── T27 句子成分 ─────────────────────────

/**
 * 句中标号。
 *
 * **`component` 与 `pos` 是两个独立字段**：前者取 `S/V/O/C/ADVERBIAL`，
 * 后者取词性集合，两者不得互相校验、不得共用同一字段。
 */
export interface SentenceTokenDto {
  text: string;
  component: SentenceComponent | null;
  pos: PartOfSpeech | null;
}

/** 句子分析行 DTO。 */
export interface SentenceRowDto {
  id: string;
  stageId: string;
  sentenceEn: string;
  sentenceZh: string | null;
  tokens: SentenceTokenDto[];
  isCorrect: boolean;
  errorReason: string | null;
  patternTag: PatternTag | null;
  patternLabel: string | null;
  sentenceDate: string;
  createdAt: string;
}

/** 句子页统计。 */
export interface SentenceStatsDto {
  total: number;
  correct: number;
  error: number;
  componentCounts: { component: SentenceComponent; label: string; count: number }[];
  patterns: { tag: PatternTag; label: string; count: number }[];
}

// ───────────────────────── T29 周复盘 ─────────────────────────

/** 13 项指标中的一项（auto 为系统值，override 为用户覆盖值）。 */
export interface WeeklyMetricValueDto {
  key: WeeklyMetricKey;
  label: string;
  autoValue: string;
  overrideValue: string | null;
  effectiveValue: string;
  overridden: boolean;
}

/** Top3 薄弱点（必须填满 3 项）。 */
export interface WeeklyTop3Dto {
  name: string;
  score: number;
  evidence: string;
  manual: boolean;
}

/** 周复盘 DTO（未保存时 `id` 为 null，指标为实时计算值）。 */
export interface WeeklyReviewDto {
  id: string | null;
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  isPartial: boolean;
  metrics: WeeklyMetricValueDto[];
  top3: WeeklyTop3Dto[];
  reviewNote: string | null;
  exportedAt: string | null;
  savedAt: string | null;
}

/** 周次下拉选项。 */
export interface WeeklyWeekOptionDto {
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  label: string;
  saved: boolean;
}

// ───────────────────────── T30 / T31 图表 ─────────────────────────

/**
 * 通用序列点。
 * `value` 为 `null` = 该点无数据（折线断开，**不补 0**）。
 */
export interface SeriesPointDto {
  label: string;
  value: number | null;
  /** 附加维度说明，用于 tooltip / 副标题。 */
  hint?: string;
}

/** 十张图的数据源（全部由数据库聚合而来）。 */
export interface AnalyticsDto {
  windowDays: number;
  /** T31-1 每日时长 */
  dailyMinutes: SeriesPointDto[];
  /** T31-2 每周时长 */
  weeklyMinutes: SeriesPointDto[];
  /** T31-3 四科（含泛练与语言知识）投入分布 */
  skillDistribution: SeriesPointDto[];
  /** T31-4 各阶段投入 */
  stageInvestment: SeriesPointDto[];
  /** T31-5 EGIU 三色分布 */
  egiuColors: SeriesPointDto[];
  /** T31-6 语法正确率趋势 */
  grammarAccuracy: SeriesPointDto[];
  /** T31-7 词汇积累 */
  vocabGrowth: SeriesPointDto[];
  /** T31-8 周完成率 */
  weeklyCompletion: SeriesPointDto[];
  /** T31-9 错题类型 */
  mistakeTypes: SeriesPointDto[];
  /** T31-10 科目记录历史 */
  skillHistory: SeriesPointDto[];
}

// ───────────────────────── T32 全局筛选 ─────────────────────────

/** 全局筛选态（默认值由服务端填，页面不必再判空）。 */
export interface GlobalFilterDto {
  from: string;
  to: string;
  stageId: string | null;
  skill: SkillId | null;
  resourceId: string | null;
}

export interface FilterOptionDto {
  value: string;
  label: string;
}

/** 筛选下拉选项（数据驱动，资源名来自 `Resource` 表）。 */
export interface GlobalFilterOptionsDto {
  stages: FilterOptionDto[];
  skills: FilterOptionDto[];
  resources: FilterOptionDto[];
}

// ───────────────────────── T35 AI 预留 ─────────────────────────

/** AI 建议 DTO。`basis` 是必须展示的「依据」，不可隐藏。 */
export interface AiSuggestionDto {
  id: string;
  scope: AiScope;
  scopeLabel: string;
  refKey: string | null;
  status: string;
  statusLabel: string;
  title: string;
  body: string;
  basis: string | null;
  provider: string | null;
  createdAt: string;
}


// ───────────────────────── v2.2 证据域 ─────────────────────────

/** 证据覆盖的技能。GRAMMAR / VOCABULARY 用于知识型证据（不参与四技能迁移链）。 */
export type EvidenceSkill =
  | 'LISTENING'
  | 'READING'
  | 'SPEAKING'
  | 'WRITING'
  | 'GRAMMAR'
  | 'VOCABULARY';

/** 学习证据类型（E0–E5 生命周期）。注意与 v2.0 附件类型 `EvidenceType` 区分。 */
export type LearningEvidenceType =
  | 'BASELINE'
  | 'ASSISTED'
  | 'IMMEDIATE_RETEST'
  | 'DELAYED_RETEST'
  | 'APPLIED_TASK'
  | 'TRANSFER';

/** 证据记录级别：Quick 日常 / Standard 阶段关键 / Full 完整证据链。 */
export type EvidenceLevel = 'QUICK' | 'STANDARD' | 'FULL';

/** AI / 工具辅助级别。A4 绝不计为学习者独立产出。 */
export type AssistanceLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export type EvidenceConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type AssessorType = 'SELF' | 'TEACHER' | 'PEER' | 'AI' | 'EXAM';
export type EvidencePrivacy = 'PRIVATE' | 'SHAREABLE' | 'METADATA_ONLY';

/** 分项能力方向（仅方向性描述，不是官方等级）。 */
export type SkillDirection = 'Pre-A1' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export type RetestType = 'IMMEDIATE' | 'DELAYED' | 'APPLIED' | 'TRANSFER';
export type RetestStatus = 'PENDING' | 'DONE' | 'SKIPPED' | 'SUPERSEDED';

export type CycleStatus = 'CALIBRATION' | 'BUILD' | 'DELIVER' | 'COMPLETED' | 'PAUSED';
export type CyclePhaseCode = 'CALIBRATION' | 'BUILD' | 'DELIVER';
export type WeeklyFocusStatus = 'OPEN' | 'REVIEWED';

export type AIActionType =
  | 'HINT'
  | 'EXPLAIN'
  | 'CORRECT'
  | 'REWRITE'
  | 'GENERATE'
  | 'SCORE'
  | 'TRANSLATE'
  | 'OTHER';
export type AdoptionStatus = 'ADOPTED' | 'PARTIAL' | 'REJECTED';

export type ResourcePriority = 'P0' | 'P1' | 'P2';
export type ResourceReadStatus =
  | 'NOT_STARTED'
  | 'READING'
  | 'SUMMARIZED'
  | 'APPLIED'
  | 'DONE';

/** 方法论资料库分类（六类，与阅读阶段无关）。 */
export type MethodologyCategory = '入口' | '诊断' | '证据' | '复盘' | 'AI' | '工具';

/** 任务/条件快照（证据的「在什么条件下完成」）。 */
export interface EvidenceConditionDto {
  prompt: string | null;
  materialSource: string | null;
  timeLimitMinutes: number | null;
  toolsAllowed: string[];
  audience: string | null;
  environment: string | null;
}

/** 证据列表行。 */
export interface EvidenceRowDto {
  id: string;
  skill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  level: EvidenceLevel;
  parentEvidenceId: string | null;
  chainRootId: string | null;
  outputPreview: string | null;
  score: number | null;
  scoreReason: string | null;
  evidenceAnchor: string | null;
  assistanceLevel: AssistanceLevel;
  independent: boolean;
  assessorType: AssessorType;
  confidence: EvidenceConfidence;
  hasArtifact: boolean;
  childCount: number;
  archivedAt: string | null;
  createdAt: string;
}

/** 证据详情（含条件、维度、附件与链关系）。 */
export interface EvidenceDetailDto extends EvidenceRowDto {
  condition: EvidenceConditionDto | null;
  dimensions: Record<string, number> | null;
  outputText: string | null;
  privacyLevel: EvidencePrivacy;
  note: string | null;
  artifact: {
    id: string;
    fileUri: string;
    mimeType: string | null;
    evidenceType: string;
    privacyLevel: EvidencePrivacy;
    consentStatus: string;
  } | null;
  parent: { id: string; evidenceType: LearningEvidenceType; createdAt: string } | null;
  children: Array<{ id: string; evidenceType: LearningEvidenceType; createdAt: string }>;
}

/** 分项能力画像。 */
export interface SkillProfileDto {
  skill: 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING';
  direction: SkillDirection | null;
  confidence: EvidenceConfidence;
  evidenceBasis: string[];
  lastAssessedAt: string | null;
  reviewDueAt: string | null;
  doNotInfer: string | null;
  note: string | null;
}

/** 画像页可选作「证据依据」的记录。 */
export interface ProfileEvidenceOptionDto {
  id: string;
  evidenceType: LearningEvidenceType;
  assistanceLevel: AssistanceLevel;
  independent: boolean;
  preview: string | null;
  createdAt: string;
}

/** 画像页单技能视图：画像 + 证据规模 + 系统建议 + 可选依据。 */
export interface SkillProfileRowDto extends SkillProfileDto {
  evidenceCount: number;
  independentCount: number;
  suggestion: EvidenceConfidence;
  suggestionReasons: string[];
  gaps: string[];
  options: ProfileEvidenceOptionDto[];
}

export type BarrierStatus = 'ACTIVE' | 'RESOLVED' | 'SUPERSEDED';

export type InterventionStatus = 'PLANNED' | 'RUNNING' | 'DONE' | 'ABANDONED';

/** 障碍诊断可选作「原始样本」的活动证据。 */
export interface BarrierEvidenceOptionDto {
  id: string;
  evidenceType: LearningEvidenceType;
  independent: boolean;
  preview: string | null;
  createdAt: string;
}

export interface BarrierDiagnosisDto {
  id: string;
  skill: EvidenceSkill;
  barrierType: string;
  barrierLabel: string;
  evidenceId: string | null;
  evidenceAnchor: string | null;
  impact: string;
  confidence: EvidenceConfidence;
  selectedFocus: boolean;
  status: BarrierStatus;
  note: string | null;
  archivedAt: string | null;
  interventions: InterventionPlanDto[];
  createdAt: string;
}

export interface InterventionPlanDto {
  id: string;
  barrierId: string;
  action: string;
  successCriteria: string;
  scaffoldLevel: AssistanceLevel;
  estimatedMinutes: number;
  status: InterventionStatus;
  preEvidenceId: string | null;
  postEvidenceId: string | null;
}

/** 诊断页按技能分组的证据选项。 */
export type BarrierEvidenceOptionsBySkill = Partial<
  Record<EvidenceSkill, BarrierEvidenceOptionDto[]>
>;

export interface RetestQueueItemDto {
  id: string;
  parentEvidenceId: string;
  parentType: LearningEvidenceType;
  parentSkill: EvidenceSkill;
  parentPreview: string | null;
  parentCreatedAt: string;
  retestType: RetestType;
  dueDate: string;
  estMinutes: number;
  status: RetestStatus;
  planTaskId: string | null;
  completedEvidenceId: string | null;
  overdueDays: number;
}

/** 从 /retest 进入证据录入时，用于锁定技能/阶段并回填完成状态。 */
export interface RetestCompletionContextDto {
  scheduleId: string;
  skill: EvidenceSkill;
  retestType: RetestType;
  evidenceType: LearningEvidenceType;
  level: EvidenceLevel;
  dueDate: string;
  estMinutes: number;
  parentPreview: string | null;
  parentPrompt: string | null;
  parentMaterialSource: string | null;
}

export interface LearningCycleDto {
  id: string;
  title: string;
  goal: string;
  deliverable: string | null;
  startDate: string;
  endDate: string;
  status: CycleStatus;
  phase: CyclePhaseCode | null;
  dayIndex: number;
  baselineRefs: string[];
  recoveryNote: string | null;
  weeklyFocus: WeeklyFocusDto[];
}

export interface WeeklyFocusDto {
  id: string;
  cycleId: string;
  weekIndex: number;
  weekStart: string;
  focusQuestion: string;
  inputText: string | null;
  outputText: string | null;
  feedbackText: string | null;
  transferEvidenceId: string | null;
  nextDecision: string | null;
  status: WeeklyFocusStatus;
}

/** 周主问题的六个槽位（复盘必须填满前五项中的四个文本槽，迁移证据可后补）。 */
export type WeeklyFocusSlot =
  | 'question'
  | 'input'
  | 'output'
  | 'feedback'
  | 'transfer'
  | 'decision';

/** 可挂到周复盘的证据选项（用于迁移证据下拉）。 */
export interface CycleEvidenceOptionDto {
  id: string;
  skill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  level: EvidenceLevel;
  preview: string | null;
  businessDate: string;
}

/** /cycle 页面一次性取数结果。 */
export interface CycleBoardDto {
  active: LearningCycleDto | null;
  history: LearningCycleDto[];
  evidenceOptions: CycleEvidenceOptionDto[];
  /** 当前周期内「可比较输出」数量（Quick 不计）。 */
  comparableOutputs: number;
  /** 当前周期内实际应用 + 迁移验证证据数量。 */
  deliveryEvidence: number;
}

export interface AiUsageRecordDto {
  id: string;
  toolName: string;
  modelVersion: string | null;
  assistanceLevel: AssistanceLevel;
  actionType: AIActionType;
  purpose: string | null;
  inputRef: string | null;
  outputRef: string | null;
  adoptedOrRejected: AdoptionStatus;
  independent: boolean;
  evidenceId: string | null;
  evidenceSkill: EvidenceSkill | null;
  evidencePreview: string | null;
  createdAt: string;
}

/** Coach 协议步骤：先自己尝试，再诊断、提示、练习、复测、回到证据。 */
export type CoachStep =
  | 'ATTEMPT'
  | 'DIAGNOSE'
  | 'HINT'
  | 'PRACTICE'
  | 'RETEST'
  | 'EVIDENCE';

export interface MethodologyResourceDto {
  id: string;
  title: string;
  creator: string | null;
  url: string;
  resourceType: string;
  priority: ResourcePriority;
  sourceUpdated: string | null;
  accessedAt: string | null;
  licenseNote: string | null;
  stageFit: string[];
  status: string;
  category: string | null;
  summary: string | null;
  reading: {
    status: ResourceReadStatus;
    personalSummary: string | null;
    plannedAction: string | null;
    appliedEvidenceId: string | null;
    lastReadAt: string | null;
  } | null;
}

/** 资料库「已实践」可关联的证据选项（只读下拉用）。 */
export interface LibraryEvidenceOptionDto {
  id: string;
  skill: EvidenceSkill;
  evidenceType: LearningEvidenceType;
  preview: string;
  businessDate: string;
}

// ───────────────────────── v2.3 TypeWords 词汇集成 ─────────────────────────

export type VocabImportRowStatus = 'NEW' | 'DUPLICATE_IN_FILE' | 'EXISTS' | 'CONFLICT' | 'INVALID';

export interface NormalizedVocabItem {
  lemma: string;
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  definitionZh: string | null;
  definitionEn: string | null;
  phoneticUk: string | null;
  phoneticUs: string | null;
  examples: string[];
  collocations: string[];
  tags: string[];
  sourceRef: string | null;
}

export interface VocabImportRow {
  line: number;
  status: VocabImportRowStatus;
  item: NormalizedVocabItem | null;
  /** 原始行（已按表头映射），用于「查看原值」。 */
  raw: Record<string, string>;
  messages: string[];
}

export interface VocabImportPreview {
  format: 'CSV' | 'TSV' | 'JSON';
  headers: string[];
  /** 表头 → 字段的自动映射；未映射的列在 UI 中灰显。 */
  mapping: Record<string, string>;
  total: number;
  counts: Record<VocabImportRowStatus, number>;
  rows: VocabImportRow[];
  truncated: boolean;
  blockingErrors: string[];
}

export interface VocabDeckDto {
  id: string;
  title: string;
  targetStage: string | null;
  version: number;
  dailyNewTarget: number;
  reviewCap: number;
  status: string;
  itemCount: number;
  externalDeckId: string | null;
  lastSyncedAt: string | null;
  note: string | null;
}

export interface VocabLibraryStatsDto {
  items: number;
  decks: number;
  dueReview: number;
  introducedToday: number;
  /** 七个维度各自「已验证」的词条数（不合并）。 */
  dimensionVerified: Record<VocabDimension, number>;
  lastImportAt: string | null;
  lastSessionAt: string | null;
}

export interface VocabAssignmentItemDto {
  itemId: string;
  lemma: string;
  pos: string;
  definitionZh: string | null;
  priority: TaskPriority;
  kind: 'REVIEW' | 'NEW' | 'WEAKNESS';
  mode: VocabPracticeMode | null;
}

export interface VocabAssignmentDto {
  id: string;
  assignmentDate: string;
  budgetMinutes: number;
  reviewTarget: number;
  newTarget: number;
  estimatedMinutes: number;
  status: string;
  rationale: string | null;
  deckId: string | null;
  deckTitle: string | null;
  planTaskId: string | null;
  externalDeckId: string | null;
  sentAt: string | null;
  items: VocabAssignmentItemDto[];
  priorityPolicy: Record<string, unknown> | null;
}

export interface VocabPracticeSessionDto {
  id: string;
  externalSessionId: string;
  mode: string | null;
  granularity: VocabSessionGranularity;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  effectiveSeconds: number;
  overlapAdjusted: boolean;
  correctCount: number | null;
  incorrectCount: number | null;
  studySessionId: string | null;
  importedAt: string;
}

export interface VocabIntegrationJobDto {
  id: string;
  provider: string;
  direction: string;
  status: string;
  fileName: string | null;
  countsJson: string | null;
  errorReport: string | null;
  retryCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface VocabConnectionDto {
  id: string;
  provider: string;
  name: string;
  mode: VocabIntegrationMode;
  pinnedVersion: string | null;
  licenseNote: string | null;
  enabled: boolean;
  lastSyncAt: string | null;
}

export interface VocabWordDetailDto {
  id: string;
  lemma: string;
  pos: string;
  senseKey: string;
  definitionZh: string | null;
  definitionEn: string | null;
  phoneticUk: string | null;
  phoneticUs: string | null;
  examples: string[];
  collocations: string[];
  tags: string[];
  sourceTitle: string | null;
  sourceType: string;
  dimensions: Array<{
    dimension: VocabDimension;
    status: VocabDimensionStatus;
    confidence: string;
    evidenceCount: number;
    lastVerifiedAt: string | null;
  }>;
  recentSessions: VocabPracticeSessionDto[];
  recentEvidence: Array<{
    id: string;
    dimension: VocabDimension;
    evidenceType: string;
    level: string;
    score: number | null;
    businessDate: string;
  }>;
}

export interface VocabAnalyticsDto {
  range: { from: string; to: string };
  dailyMinutes: Array<{ date: string; minutes: number; sessions: number }>;
  modeMinutes: Array<{ mode: VocabPracticeMode; minutes: number }>;
  newPerDay: Array<{ date: string; count: number }>;
  dimensionCoverage: Array<{
    dimension: VocabDimension;
    verified: number;
    introduced: number;
  }>;
  accuracyTrend: Array<{ date: string; correct: number; incorrect: number }>;
  planningVsActual: Array<{ date: string; planned: number; actual: number }>;
}
