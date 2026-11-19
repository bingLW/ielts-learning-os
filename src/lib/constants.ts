/**
 * 全站唯一常量与阈值来源。
 *
 * 规则（架构 §6）：任何数字在 `domain/`、`actions/`、页面中都不得出现字面量；
 * 需要新增阈值时先在这里加常量，再引用。
 */

import type {
  AcceptanceDimension,
  AdoptionStatus,
  AIActionType,
  AiScope,
  AiStatus,
  AllocationSkill,
  AssessmentType,
  AssessorKind,
  AssessorType,
  AssistanceLevel,
  BarrierStatus,
  BatchReviewOp,
  CefrLevel,
  CoachStep,
  CyclePhaseCode,
  CycleStatus,
  ErrorCategory,
  EgiuColor,
  EvidenceConfidence,
  EvidenceEntity,
  EvidenceLevel,
  EvidencePrivacy,
  EvidenceSkill,
  EvidenceType,
  GlobalFilterKey,
  GoalStatus,
  GoalType,
  IeltsErrorCategory,
  IeltsTestType,
  IntervalCode,
  JudgeBranch,
  LearningEvidenceType,
  LearningTrack,
  MasteryLevel,
  MediatedIntensity,
  MediatedUnderstanding,
  MethodologyCategory,
  MilestoneStatus,
  MistakeSource,
  ModuleId,
  OutputType,
  PartOfSpeech,
  PatternTag,
  PrimarySkill,
  ResourcePriority,
  ResourceReadStatus,
  RetestStatus,
  RetestType,
  ReviewStageCode,
  ReviewStatus,
  SentenceComponent,
  SkillAllocation,
  SkillBucket,
  SkillDirection,
  SkillId,
  StageCode,
  StageProfileCode,
  StageStatus,
  TargetType,
  TaskStatus,
  TransitionDecidedBy,
  TranslationDependency,
  Verdict,
  WeeklyFocusSlot,
  WeeklyFocusStatus,
  WeeklyMetricKey,
} from './types';

// ───────────────────────── 系统 ─────────────────────────

/** Asia/Singapore 无夏令时，固定 +08:00。全站唯一时区。 */
export const TZ_OFFSET_MINUTES = 480;
export const TZ_NAME = 'Asia/Singapore';
export const SCHEMA_VERSION = 1;
export const BACKUP_KEEP = 7;

export const DISCLAIMER_CEFR =
  '阶段对应关系为学习路径规划，非 CEFR 官方认证或测评结果。';
export const DISCLAIMER_BAND =
  '所有分数均为「个人目标分 / 我的模考记录（非官方成绩）」，不代表官方测评结果。';

// ───────────────────────── 模块与科目 ─────────────────────────

/** SOP 主线 9 模块排序（严格顺序，允许用户手动调序并持久化）。 */
export const MODULE_ORDER: ModuleId[] = [
  'VOCAB_REVIEW',
  'GRAMMAR',
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'SENTENCE',
  'REVIEW_PLAN',
  'EXTENSIVE',
];

/**
 * v2.0：媒介学习作为**可选第 10 个模块**，独立于 9 模块基础版。
 *
 * 为什么不放进 `MODULE_ORDER`：9 模块 240min 是 v1 冻结的容量契约
 * （`domain/plan.ts` 的增量分配与 20% 语法封顶都按这 9 项算）。把媒介学习塞进去
 * 会改变所有既有配平的语义。正确做法是：从「支持性/复习预算」里划出分钟数，
 * 以额外任务行追加（见 `applyMediatedMinutes`），`Σminutes` 仍等于 `dailyMinutes`。
 */
export const MEDIATED_MODULE: ModuleId = 'MEDIATED';

/** S0 只生成 3 个基线任务（合计 90min）。 */
export const S0_MODULES: ModuleId[] = [
  'BASELINE_LISTEN',
  'BASELINE_READ',
  'BASELINE_OUTPUT',
];

export interface ModuleMeta {
  labelZh: string;
  skill: SkillId;
  defaultMinutes: number;
  canExtend: boolean;
}

/** 模块元数据。`defaultMinutes` 为 SOP §2 基础版数值，不可改动。 */
export const MODULE_META: Record<ModuleId, ModuleMeta> = {
  VOCAB_REVIEW: { labelZh: '词汇复习', skill: 'VOCAB', defaultMinutes: 25, canExtend: true },
  GRAMMAR: { labelZh: '语法/句型', skill: 'GRAMMAR', defaultMinutes: 40, canExtend: true },
  LISTENING: { labelZh: '听力精听', skill: 'LISTENING', defaultMinutes: 45, canExtend: true },
  READING: { labelZh: '阅读精读', skill: 'READING', defaultMinutes: 40, canExtend: true },
  SPEAKING: { labelZh: '口语', skill: 'SPEAKING', defaultMinutes: 30, canExtend: true },
  WRITING: { labelZh: '写作', skill: 'WRITING', defaultMinutes: 20, canExtend: true },
  SENTENCE: { labelZh: '句子成分', skill: 'SENTENCE', defaultMinutes: 15, canExtend: true },
  REVIEW_PLAN: { labelZh: '复盘与计划', skill: 'META', defaultMinutes: 10, canExtend: false },
  EXTENSIVE: { labelZh: '泛听泛读', skill: 'LISTENING_EXT', defaultMinutes: 15, canExtend: true },
  MEDIATED: { labelZh: '英语媒介学习', skill: 'MEDIATED', defaultMinutes: 0, canExtend: true },
  BASELINE_LISTEN: {
    labelZh: '基线听力诊断',
    skill: 'LISTENING',
    defaultMinutes: 30,
    canExtend: false,
  },
  BASELINE_READ: {
    labelZh: '基线阅读诊断',
    skill: 'READING',
    defaultMinutes: 30,
    canExtend: false,
  },
  BASELINE_OUTPUT: {
    labelZh: '基线口写诊断',
    skill: 'SPEAKING',
    defaultMinutes: 30,
    canExtend: false,
  },
  /**
   * v2.1 P0 到期复习块。
   *
   * 为什么单独一个模块而不是复用「复习与计划」：`REVIEW_PLAN` 是排计划/写复盘的管理时间，
   * 而这里是真正的到期复习执行（EGIU 复测、错题重做、词汇抽测）。两者混用会让
   * 「管理时间」虚高、复习量失真。本模块计入 META（管理复盘）之外的独立复习时间，
   * **不进入四技能分母**（primarySkill = FOUNDATION）。
   */
  P0_REVIEW: { labelZh: '到期复习', skill: 'META', defaultMinutes: 0, canExtend: true },
  /**
   * v2.2 技能型证据复测块（由 `RetestSchedule` 到期排入，生成引擎不产出本模块）。
   * 计入 FOUNDATION 桶，**不进入四技能分母**，避免复测把技能训练量虚高。
   */
  EVIDENCE_RETEST: { labelZh: '证据复测', skill: 'META', defaultMinutes: 10, canExtend: true },
};

export const SKILL_IDS: SkillId[] = [
  'VOCAB',
  'GRAMMAR',
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'SENTENCE',
  'META',
  'LISTENING_EXT',
  'READING_EXT',
  'MEDIATED',
];

export const SKILL_LABEL_ZH: Record<SkillId, string> = {
  VOCAB: '词汇',
  GRAMMAR: '语法',
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  SENTENCE: '句子成分',
  META: '复盘与计划',
  LISTENING_EXT: '泛听',
  READING_EXT: '泛读',
  MEDIATED: '英语媒介学习',
};

/**
 * 分钟数分桶。泛听/泛读只进 EXTENSIVE，绝不并入精练统计；
 * 复盘与计划（META）独立成 `META` 桶，**不并入 SENTENCE**（否则每天 10 分钟复盘
 * 会被算成句子成分练习，一周虚增 70 分钟）。
 */
export const SKILL_BUCKET: Record<SkillId, SkillBucket> = {
  VOCAB: 'VOCAB',
  GRAMMAR: 'GRAMMAR',
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
  SENTENCE: 'SENTENCE',
  META: 'META',
  LISTENING_EXT: 'EXTENSIVE',
  READING_EXT: 'EXTENSIVE',
  MEDIATED: 'MEDIATED',
};

/**
 * 分钟数分桶的**展示顺序**（四科分布图 / Dashboard 四项投入 / 周复盘分桶标签共用）。
 *
 * 刻意**不含** `META`：这张顺序表只描述「听说读写 + 泛练 + 语言知识」六个业务维度，
 * 复盘时间不进四科分布（`META` 桶仍由 `skillMinutes` 正常汇总，只是不参与图表与占比）。
 */
export const SKILL_BUCKET_ORDER: SkillBucket[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'EXTENSIVE',
  'VOCAB',
  'GRAMMAR',
  'SENTENCE',
];

export const SKILL_BUCKET_LABEL_ZH: Record<SkillBucket, string> = {
  LISTENING: '听力精练',
  READING: '阅读精读',
  SPEAKING: '口语',
  WRITING: '写作',
  EXTENSIVE: '泛听泛读',
  VOCAB: '词汇',
  GRAMMAR: '语法',
  SENTENCE: '句子成分',
  META: '复盘与计划',
  MEDIATED: '英语媒介学习',
};

// ───────────────────────── 阶段 ─────────────────────────

export const STAGE_CODES: StageCode[] = ['S0_PREP', 'S1_A0_A2', 'S2_A2_B1', 'S3_B1_IELTS'];

export interface StageMeta {
  nameZh: string;
  estDaysMin: number;
  estDaysMax: number | null;
  allowedEgiu: boolean;
  sortOrder: number;
}

/**
 * 阶段元数据。`nameZh` 固定带「训练区间」措辞 —— 避免被读成 CEFR 官方等级。
 * `allowedEgiu`：EGIU 单元判定只允许 S1/S2（S0/S3 传入返回 PRECONDITION）。
 */
export const STAGE_META: Record<StageCode, StageMeta> = {
  S0_PREP: {
    nameZh: '阶段零 · 准备与诊断（A0 前测区间）',
    estDaysMin: 1,
    estDaysMax: 2,
    allowedEgiu: false,
    sortOrder: 0,
  },
  S1_A0_A2: {
    nameZh: '阶段一 · 基础英语（A0→A2 训练区间）',
    estDaysMin: 120,
    estDaysMax: 180,
    allowedEgiu: true,
    sortOrder: 1,
  },
  S2_A2_B1: {
    nameZh: '阶段二 · 中级英语（A2→B1 训练区间）',
    estDaysMin: 90,
    estDaysMax: 120,
    allowedEgiu: true,
    sortOrder: 2,
  },
  S3_B1_IELTS: {
    nameZh: '阶段三 · 雅思应试（B1→IELTS 训练区间）',
    estDaysMin: 90,
    estDaysMax: 150,
    allowedEgiu: false,
    sortOrder: 3,
  },
};

export const STAGE_STATUSES: StageStatus[] = ['NOT_STARTED', 'ACTIVE', 'COMPLETED', 'SKIPPED'];

export const STAGE_STATUS_LABEL_ZH: Record<StageStatus, string> = {
  NOT_STARTED: '未开始',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  SKIPPED: '手动跳过',
};

export const ACCEPTANCE_DIMENSIONS: AcceptanceDimension[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'GRAMMAR',
  'VOCAB',
  'SENTENCE',
];

export const ACCEPTANCE_DIMENSION_LABEL_ZH: Record<AcceptanceDimension, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  GRAMMAR: '语法',
  VOCAB: '词汇',
  SENTENCE: '句子结构',
};

/** H1 必验项：听力、阅读、口语、写作、语法各 ≥1 项 PASSED。 */
export const REQUIRED_DIMENSIONS: AcceptanceDimension[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'GRAMMAR',
];

export const VERDICTS: Verdict[] = ['PENDING', 'PASSED', 'FAILED'];

export const VERDICT_LABEL_ZH: Record<Verdict, string> = {
  PENDING: '待判定',
  PASSED: '通过',
  FAILED: '未通过',
};

export const TRANSITION_DECIDED_BY: Record<TransitionDecidedBy, string> = {
  SYSTEM_SUGGESTED: '系统建议',
  USER: '用户手动',
};

/** 手动升级原因最小长度（PRD §6.4 硬要求）。 */
export const TRANSITION_REASON_MIN_LENGTH = 10;

// ───────────────────────── 时长与计划 ─────────────────────────

export const DAILY_MINUTES_PRESETS = [240, 270, 300];
export const DAILY_MINUTES_MIN = 240;
export const DAILY_MINUTES_MAX = 300;
export const GRAMMAR_CAP_RATIO = 0.2;
/** 单科单日增量上限：说/听/读可至 20min。 */
export const EXTRA_CAP_SKILL = 20;
/** 其余模块单日增量上限 15min。 */
export const EXTRA_CAP_DEFAULT = 15;
/** 复盘固定 10min，不增不减。 */
export const REVIEW_PLAN_FIXED = 10;
/** SENTENCE 在 S2/S3 最多 +5。 */
export const SENTENCE_EXTRA_CAP = 5;
/** 复习负载超过可用时长 25% → 提示「复习负载过重」，但不截断。 */
export const REVIEW_LOAD_WARN_RATIO = 0.25;

// ═════════════════════════════════════════════════════════════════════════════
// v2.1 动态时间预算与自适应计划
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 每日预算下限/上限（分钟）。v2.1 取消「240 分钟最低」假设：
 * 15 分钟 = 应急维护（不视为完整学习日），1 分钟 = 微学习，600 分钟 = 硬上限。
 */
export const BUDGET_MINUTES_MIN = 1;
export const BUDGET_MINUTES_MAX = 600;

/** 首次安装的初始建议每日分钟数（必须标记为「建议」，不得当作真实可用时间）。 */
export const BUDGET_INITIAL_SUGGESTION = 60;

/** 低于该值不视为「完整学习日」（应急维护模式）。 */
export const BUDGET_MAINTENANCE_MAX = 15;

/** 任务最小时间粒度（分钟）；低于它一律不创建任务，转入周轮换。 */
export const MIN_TASK_MINUTES = 5;

/** 一档预算的完整定义。 */
export interface BudgetTier {
  code: string;
  minutes: number | null;
  /** CUSTOM 的 minutes 为 null（由用户输入）。 */
  custom: boolean;
  labelZh: string;
  subLabelZh: string;
  /** 应急维护 / 休息日不视为完整学习日。 */
  maintenanceOnly: boolean;
}

/**
 * 预设时间档次（需求手册 §4.1 表格，数值不可改）。
 * 「自定义」1–600 分钟单独由 `customBudget` 处理。
 */
export const BUDGET_TIERS: BudgetTier[] = [
  {
    code: 'EMERGENCY',
    minutes: 15,
    custom: false,
    labelZh: '应急维护',
    subLabelZh: '维持记忆连续性，不视为完整学习日',
    maintenanceOnly: true,
  },
  {
    code: 'MINIMUM',
    minutes: 30,
    custom: false,
    labelZh: '最低有效',
    subLabelZh: '一项基础/复习 + 一项核心技能',
    maintenanceOnly: false,
  },
  {
    code: 'LIGHT',
    minutes: 45,
    custom: false,
    labelZh: '轻量',
    subLabelZh: '基础巩固 + 一至两项技能',
    maintenanceOnly: false,
  },
  {
    code: 'LIGHT_STANDARD',
    minutes: 60,
    custom: false,
    labelZh: '轻量标准',
    subLabelZh: '支持模块 + 两项技能 + 简短复盘',
    maintenanceOnly: false,
  },
  {
    code: 'STANDARD',
    minutes: 90,
    custom: false,
    labelZh: '标准',
    subLabelZh: '基础、输入、输出和记录',
    maintenanceOnly: false,
  },
  {
    code: 'FOCUSED',
    minutes: 120,
    custom: false,
    labelZh: '强化',
    subLabelZh: '覆盖更多技能，增加主要弱项',
    maintenanceOnly: false,
  },
  {
    code: 'DEEP',
    minutes: 180,
    custom: false,
    labelZh: '深度',
    subLabelZh: '较完整的专项学习与较长材料',
    maintenanceOnly: false,
  },
  {
    code: 'EXTENDED',
    minutes: 240,
    custom: false,
    labelZh: '全天强化',
    subLabelZh: '完整日计划与拓展任务（不是默认最低要求）',
    maintenanceOnly: false,
  },
  {
    code: 'CUSTOM',
    minutes: null,
    custom: true,
    labelZh: '自定义',
    subLabelZh: '1–600 分钟内任意值',
    maintenanceOnly: false,
  },
];

export const BUDGET_TIER_CODES: string[] = BUDGET_TIERS.map((tier) => tier.code);

/** 预设档次分钟数（自定义除外）。 */
export const BUDGET_PRESET_MINUTES: number[] = BUDGET_TIERS.filter(
  (tier) => typeof tier.minutes === 'number',
).map((tier) => tier.minutes as number);

/** 分钟内 → 档次编码（精确命中才返回；60 返回 LIGHT_STANDARD 而不是「自定义」）。 */
export function tierCodeOf(minutes: number): string {
  const hit = BUDGET_TIERS.find((tier) => tier.minutes === minutes);
  return hit ? hit.code : 'CUSTOM';
}

/** 档次编码 → 中文名（未知值原样返回，避免 UI 出现空白）。 */
export function tierLabelZh(code: string | null | undefined): string {
  if (!code) return '未设置';
  if (code === 'REST') return '休息日';
  const hit = BUDGET_TIERS.find((tier) => tier.code === code);
  return hit ? hit.labelZh : code;
}

/**
 * 各档次的时间池模板（需求手册 §5.4，「可编辑的初始参考模板，不是固定课表」）。
 *
 * `foundation` = 词汇/复习 + 语法/基础；`skill` = 四技能训练池；`review` = 复盘。
 * 三者合计 = 该档分钟数。系统读取模板后仍受「技能池按阶段配比 + 最小粒度」二次约束，
 * 模板只是**起点**，不是最终分配。
 */
export interface BudgetTemplate {
  foundation: number;
  skill: number;
  review: number;
}

export const BUDGET_TEMPLATES: Record<string, BudgetTemplate> = {
  EMERGENCY: { foundation: 5, skill: 8, review: 2 },
  MINIMUM: { foundation: 13, skill: 12, review: 5 },
  LIGHT: { foundation: 15, skill: 25, review: 5 },
  LIGHT_STANDARD: { foundation: 20, skill: 35, review: 5 },
  STANDARD: { foundation: 25, skill: 60, review: 5 },
  FOCUSED: { foundation: 30, skill: 80, review: 10 },
  DEEP: { foundation: 40, skill: 125, review: 15 },
  EXTENDED: { foundation: 55, skill: 170, review: 15 },
};

/** 自定义预算按该比例切分（支持模块 25%、复盘 5%、其余给技能池）。 */
export const CUSTOM_TEMPLATE_FOUNDATION_RATIO = 0.25;
export const CUSTOM_TEMPLATE_REVIEW_RATIO = 0.05;

/** 优先级定义（P0–P3，需求手册 §5.2）。 */
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

export const TASK_PRIORITY_LABEL_ZH: Record<string, string> = {
  P0: 'P0 到期复习',
  P1: 'P1 阶段核心',
  P2: 'P2 弱项强化',
  P3: 'P3 拓展练习',
};

/** P0 backlog 占当日预算的上限：超过则按逾期风险分批，避免整天只剩复习。 */
export const P0_CAP_RATIO = 0.6;

/** 当前阶段核心学习的最低保障比例：预算再紧也留出这部分给 P1。 */
export const CORE_MIN_RATIO = 0.3;

/** 短时计划（≤ 该分钟数）只安排一个主要技能，不强行铺满四项。 */
export const SHORT_PLAN_MAX_MINUTES = 45;

/** 每周目标建议：不得高于近 2–4 周稳定均值的 115%（负荷管理建议，可忽略）。 */
export const WEEKLY_SUGGEST_GROWTH = 1.15;

/** 计算「可持续周均值」使用的回看周数。 */
export const WEEKLY_SUSTAIN_LOOKBACK_WEEKS = 4;

/** 任务来源分类。 */
export const TASK_SOURCE_KINDS = [
  'REVIEW',
  'CORE',
  'WEAKNESS',
  'EXTENDED',
  'MANUAL',
  'LEGACY',
  'RETEST',
] as const;

export const TASK_SOURCE_LABEL_ZH: Record<string, string> = {
  REVIEW: '复习',
  CORE: '阶段核心',
  WEAKNESS: '弱项',
  EXTENDED: '拓展',
  MANUAL: '手工',
  LEGACY: 'v2.0 历史',
  RETEST: '证据复测',
};

// ───────────────────────── EGIU 三色判定 ─────────────────────────

export const EGIU_COLORS: EgiuColor[] = ['PENDING', 'GREEN', 'YELLOW', 'RED'];

export const EGIU_COLOR_LABEL_ZH: Record<EgiuColor, string> = {
  PENDING: '待判定',
  GREEN: '绿灯',
  YELLOW: '黄灯',
  RED: '红灯',
};

/** 题量 ≥5 时正确率可信，直接按 SOP 三色表映射。 */
export const FULL_VOLUME_MIN_QUESTIONS = 5;
export const GREEN_ACC = 0.9;
export const YELLOW_ACC = 0.7;

/** 题量 1..4 的降权权重（acc 30% + explain 40% + sentence 30%）。 */
export const LOW_VOLUME_W = { ACC: 0.3, EXPLAIN: 0.4, SENTENCE: 0.3 };
/** 降权档要判 GREEN 的综合分门槛。 */
export const LOW_VOLUME_PASS = 0.85;
/** 造句达标的句子数。 */
export const LOW_VOLUME_MIN_SENTENCES = 2;
/** 只造 1 句时给的折半句分（0.30 的一半）。 */
export const LOW_VOLUME_SENTENCE_HALF = 0.15;

export const REASON_SEPARATOR = '；';

// ───────────────────────── 复习调度 ─────────────────────────

export const REVIEW_INTERVAL_DAYS: Record<IntervalCode, number> = {
  D1: 1,
  D3: 3,
  D7: 7,
  D14: 14,
  D21: 21,
  D30: 30,
  MANUAL: 2,
  LOW_FREQ_30: 30,
};

/**
 * 判定结果 → 结构化复习点。
 * GREEN 不进结构化复习（进 D7 周抽测池）；PENDING 不排程。
 */
export const COLOR_INTERVALS: Record<EgiuColor, IntervalCode[]> = {
  GREEN: [],
  YELLOW: ['D1', 'D3', 'D7'],
  RED: ['D1', 'D3', 'D7', 'D14'],
  PENDING: [],
};

/** total<5 且判 YELLOW → 追加一个 +2 天的 MANUAL 补测。 */
export const LOW_VOLUME_RETEST_OFFSET = 2;
/** 同一知识点最多同时存在 4 个未完成的未来复习点。 */
export const MAX_PENDING_POINTS = 4;
/** 连续 2 次 GREEN 且间隔 ≥7 天 → 掌握。 */
export const MASTERY_GREEN_STREAK = 2;
export const MASTERY_MIN_GAP_DAYS = 7;
/** 掌握后转 30 天低频抽测池。 */
export const LOW_FREQ_INTERVAL_DAYS = 30;

/** 各间隔档的预估分钟（用于日复习负载计算）。 */
export const EST_MINUTES_BY_INTERVAL: Record<IntervalCode, number> = {
  D1: 5,
  D3: 8,
  D7: 10,
  D14: 12,
  D21: 12,
  D30: 15,
  MANUAL: 10,
  LOW_FREQ_30: 15,
};

export const REVIEW_STATUSES: ReviewStatus[] = ['PENDING', 'DONE', 'SKIPPED', 'SUPERSEDED'];

export const REVIEW_STATUS_LABEL_ZH: Record<ReviewStatus, string> = {
  PENDING: '待复习',
  DONE: '已完成',
  SKIPPED: '已跳过',
  SUPERSEDED: '已被取代',
};

export const INTERVAL_CODES: IntervalCode[] = [
  'D1',
  'D3',
  'D7',
  'D14',
  'D21',
  'D30',
  'MANUAL',
  'LOW_FREQ_30',
];

export const INTERVAL_LABEL_ZH: Record<IntervalCode, string> = {
  D1: 'D1 次日回忆',
  D3: 'D3 重做错题',
  D7: 'D7 周抽测',
  D14: 'D14 长期复测',
  D21: 'D21 复测',
  D30: 'D30 月度复测',
  MANUAL: '补测',
  LOW_FREQ_30: '低频抽测（30 天）',
};

export const TARGET_TYPES: TargetType[] = [
  'EGIU_LESSON',
  'MISTAKE',
  'VOCAB_WORD',
  'GRAMMAR_POINT',
];

export const TARGET_TYPE_LABEL_ZH: Record<TargetType, string> = {
  EGIU_LESSON: 'EGIU 单元',
  MISTAKE: '错题',
  VOCAB_WORD: '单词',
  GRAMMAR_POINT: '语法点',
};

// ───────────────────────── 聚合口径 ─────────────────────────

/** 单 session 实际时长 ≤ 计划 × 1.5（防挂机）。 */
export const NET_MAX_RATIO = 1.5;
/**
 * 计划时长为 0 时的**绝对**上限（分钟）。
 *
 * `planned ≤ 0` 时 1.5 倍上限无从计算，若不兜底则「500 分钟」也会原样入库（缺陷 D10）。
 * 180 分钟 ≈ 单日最大可用时长（300）× 0.6，超过即视为挂机并截断。
 */
export const NET_ABSOLUTE_MAX_MINUTES = 180;
/** 实际 < max(3min, 计划 × 0.2) 视为误触记 0。 */
export const NET_MIN_MINUTES = 3;
export const NET_MIN_RATIO = 0.2;
/** 计时中 >30min 无交互 → 该区间计入 idle，不计 active。 */
export const IDLE_GAP_MINUTES = 30;
/** 未结束任务在次日 24:00 后置 MISSED。 */
export const NEXT_DAY_ABANDON_HOUR = 24;

/** 计时器最短有效秒数：低于此值视为误触，不生成 session 分钟数。 */
export const TIMER_MIN_VALID_SECONDS = 60;

// ───────────────────────── 薄弱点 ─────────────────────────

export const WEAKNESS_WEIGHTS = {
  ERR: 0.35,
  ACC_GAP: 0.25,
  INVEST_GAP: 0.15,
  REVIEW_DEBT: 0.15,
  RED_DENSITY: 0.1,
} as const;

export const WEAKNESS_WINDOW_DAYS = 28;
export const WEAKNESS_MIN_QUESTIONS = 10;
export const WEAKNESS_TOP_N = 3;

// ───────────────────────── 阶段门禁 ─────────────────────────

export const GATE_H3_WINDOW_DAYS = 14;
export const GATE_H3_MIN_RATE = 0.8;
export const GATE_H4_WINDOW_DAYS = 30;
export const GATE_H4_MIN_MINUTES = 240;
export const GATE_H4_MIN_RATE = 0.8;
/** H3 只统计 D7 / D14 两个间隔档。 */
export const GATE_H3_INTERVALS: IntervalCode[] = ['D7', 'D14'];

// ───────────────────────── 词汇 ─────────────────────────

export const MASTERY_LEVELS: MasteryLevel[] = [
  'RECOGNIZE_ONLY',
  'COMPREHEND',
  'ACTIVE_USE',
];

export const MASTERY_LABEL_ZH: Record<MasteryLevel, string> = {
  RECOGNIZE_ONLY: '认识但不能用',
  COMPREHEND: '能理解',
  ACTIVE_USE: '能主动使用',
};

/** 抽测加权正确率权重。 */
export const MASTERY_WEIGHT: Record<MasteryLevel, number> = {
  ACTIVE_USE: 1.0,
  COMPREHEND: 0.7,
  RECOGNIZE_ONLY: 0.3,
};

export const VOCAB_NEW_DEFAULT = 18;
export const VOCAB_NEW_MIN = 15;
export const VOCAB_NEW_MAX = 25;
/** 上周抽测 <80% → 下调到 12。 */
export const VOCAB_NEW_DOWN = 12;
/** ≥90% → 上调到 22（上限 25）。 */
export const VOCAB_NEW_UP = 22;
export const VOCAB_ACC_DOWN_THRESHOLD = 0.8;
export const VOCAB_ACC_UP_THRESHOLD = 0.9;
export const VOCAB_NEW_STEP = 4;
export const QUIZ_SIZE = { MIN: 50, MAX: 100 };
export const QUIZ_PASS = 0.8;

export const VOCAB_SOURCES = ['Oxford3000', 'MANUAL'];

// ───────────────────────── 错题 / 句子 ─────────────────────────

export const ERROR_CATEGORIES: ErrorCategory[] = [
  'RULE_NOT_UNDERSTOOD',
  'MEMORY_CONFUSION',
  'VOCAB_UNKNOWN',
  'WORD_ORDER',
  'CARELESS',
  'OTHER',
];

export const ERROR_CATEGORY_LABEL_ZH: Record<ErrorCategory, string> = {
  RULE_NOT_UNDERSTOOD: '规则不理解',
  MEMORY_CONFUSION: '记忆混淆',
  VOCAB_UNKNOWN: '词汇不认识',
  WORD_ORDER: '语序错误',
  CARELESS: '粗心',
  OTHER: '其他',
};

export const IELTS_ERROR_CATEGORIES: IeltsErrorCategory[] = [
  'VOCAB',
  'LOCATING',
  'COMPREHENSION',
  'ATTENTION',
  'STRATEGY',
];

export const IELTS_ERROR_CATEGORY_LABEL_ZH: Record<IeltsErrorCategory, string> = {
  VOCAB: '词汇',
  LOCATING: '定位',
  COMPREHENSION: '理解',
  ATTENTION: '注意力',
  STRATEGY: '策略',
};

/** 句子成分取值集 —— 与词性取值集**不重叠**，禁止复用同一字段。 */
export const SENTENCE_COMPONENTS: SentenceComponent[] = ['S', 'V', 'O', 'C', 'ADVERBIAL'];

export const SENTENCE_COMPONENT_LABEL_ZH: Record<SentenceComponent, string> = {
  S: '主语 S',
  V: '谓语 V',
  O: '宾语 O',
  C: '补语 C',
  ADVERBIAL: '状语 Adverbial',
};

export const PARTS_OF_SPEECH: PartOfSpeech[] = [
  'NOUN',
  'VERB',
  'ADJ',
  'ADV',
  'PREP',
  'PRON',
  'OTHER',
];

export const PART_OF_SPEECH_LABEL_ZH: Record<PartOfSpeech, string> = {
  NOUN: '名词',
  VERB: '动词',
  ADJ: '形容词',
  ADV: '副词',
  PREP: '介词',
  PRON: '代词',
  OTHER: '其他',
};

export const PATTERN_TAGS: PatternTag[] = [
  'FIVE_PATTERNS',
  'RELATIVE_CLAUSE',
  'ADVERBIAL_CLAUSE',
  'NON_FINITE',
  'PASSIVE',
];

export const PATTERN_TAG_LABEL_ZH: Record<PatternTag, string> = {
  FIVE_PATTERNS: '五大句型',
  RELATIVE_CLAUSE: '定语从句',
  ADVERBIAL_CLAUSE: '状语从句',
  NON_FINITE: '非谓语',
  PASSIVE: '被动语态',
};

/** 各阶段启用的句型标签（PRD §5.8 阶段化重点）。 */
export const PATTERN_TAGS_BY_STAGE: Record<StageCode, PatternTag[]> = {
  S0_PREP: [],
  S1_A0_A2: ['FIVE_PATTERNS'],
  S2_A2_B1: ['FIVE_PATTERNS', 'RELATIVE_CLAUSE', 'ADVERBIAL_CLAUSE'],
  S3_B1_IELTS: PATTERN_TAGS,
};

// ───────────────────────── 任务状态流转 ─────────────────────────

export const TASK_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'DONE',
  'PARTIAL',
  'MISSED',
  'CANCELLED',
  'DEFERRED',
];

export const TASK_STATUS_LABEL_ZH: Record<TaskStatus, string> = {
  TODO: '待开始',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  PARTIAL: '部分完成',
  MISSED: '未完成',
  CANCELLED: '已取消',
  DEFERRED: '已延期',
};

/**
 * 合法流转白名单。
 * 关键约束：DONE 是终态，不允许回退到 TODO / IN_PROGRESS（PRD P0-05「已完成→待开始被拦截」）。
 * 需要重做时必须先「顺延」到新日期，产生新任务行，历史不被篡改。
 *
 * v2.1：CANCELLED（用户主动放弃，不计失败）与 DEFERRED（进入 backlog，未排入当日）
 * 都不是终态 —— 都可以回到 TODO 重新排入计划。
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'DONE', 'PARTIAL', 'MISSED', 'CANCELLED', 'DEFERRED'],
  IN_PROGRESS: ['DONE', 'PARTIAL', 'MISSED', 'CANCELLED', 'DEFERRED'],
  DONE: [],
  PARTIAL: ['IN_PROGRESS', 'DONE', 'MISSED', 'CANCELLED', 'DEFERRED'],
  MISSED: ['IN_PROGRESS', 'DONE', 'PARTIAL', 'CANCELLED', 'DEFERRED'],
  CANCELLED: ['TODO'],
  DEFERRED: ['TODO'],
};

/**
 * 不进入完成率分母的状态。
 * 取消 = 用户主动放弃；延期 = 尚未排入当日。两者都被误判为「失败」会让
 * 短时预算的用户永远完不成计划（需求手册 §7.2 / T06）。
 */
export const TASK_STATUSES_EXCLUDED_FROM_RATE: TaskStatus[] = ['CANCELLED', 'DEFERRED'];

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;

export const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  EASY: '简单',
  MEDIUM: '中等',
  HARD: '困难',
};

export const TERMINATED_REASONS = [
  'COMPLETED',
  'PAUSED',
  'ABANDONED',
  'MOVED',
  'TIMEOUT',
] as const;

/** 单任务最多顺延 2 次。 */
export const MAX_MOVE_COUNT = 2;

/** 复习 / 记录 / 任务的默认每页条数。 */
export const PAGE_SIZE = 50;

// ───────────────────────── 资源库（8 类由 seed 写入，代码无枚举） ─────────────────────────

export const RESOURCE_SUBJECTS = [
  'GRAMMAR',
  'VOCAB',
  'PRONUNCIATION',
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'EXAM',
] as const;

export type ResourceSubject = (typeof RESOURCE_SUBJECTS)[number];

export const RESOURCE_SUBJECT_LABEL_ZH: Record<ResourceSubject, string> = {
  GRAMMAR: '语法',
  VOCAB: '词汇',
  PRONUNCIATION: '发音',
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  EXAM: '考试',
};

export const RESOURCE_TYPES = [
  'BOOK',
  'WORDLIST',
  'WEBSITE',
  'AUDIO_SERIES',
  'GRADED_READER',
  'EXAM_PAPER',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABEL_ZH: Record<ResourceType, string> = {
  BOOK: '教材',
  WORDLIST: '词表',
  WEBSITE: '网站',
  AUDIO_SERIES: '音频系列',
  GRADED_READER: '分级读物',
  EXAM_PAPER: '真题',
};

// ───────────────────────── 导航（11 个一级入口） ─────────────────────────

export interface NavItem {
  href: string;
  labelZh: string;
  /** 简写用于移动端底部导航。 */
  shortZh: string;
  group: 'CORE' | 'DIAGNOSE' | 'TRACKS' | 'ANALYZE';
  /**
   * 阶段 C/D 已全部落地，当前没有「待开放」入口。
   * 字段保留：后续若再引入分期能力，UI 用同一套机制标注而不是隐藏入口。
   */
  pendingPhase?: string;
}

/**
 * 11 个一级入口。
 *
 * 顺序按业务方原文（PRD §3 导航裁决）：总览 → 计划 → 记录 → 语法 → 错题 → 词汇 →
 * 句子 → 资源库 → 每周复盘 → 阶段验收 → 设置。
 * 侧边栏按 `group` 分段渲染，因此**组内顺序即数组顺序**；三分组切分后仍与上面这条
 * 线性顺序一致（CORE 3 项 / DIAGNOSE 4 项 / ANALYZE 4 项）。
 *
 * 数据分析**不单列一级入口**，是 `/weekly?tab=analytics` 的一个 Tab；
 * `/analytics` 只保留为跳转路由，不进入本清单。
 *
 * 冻结条款（PRD §3）：三分组属于**呈现层细节**，规范性依据只有上面这条线性顺序。
 * 因此「改分组归属 / 去掉分组标题改扁平渲染」不算需求变更，可直接按设计判断调整；
 * 但数组顺序（= 线性顺序）不可变，改它必须同时改 PRD §3 的表格。
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', labelZh: 'Dashboard 总览', shortZh: '总览', group: 'CORE' },
  { href: '/plan', labelZh: '学习计划', shortZh: '计划', group: 'CORE' },
  { href: '/records', labelZh: '学习记录', shortZh: '记录', group: 'CORE' },
  { href: '/grammar', labelZh: '语法诊断（EGIU）', shortZh: '语法', group: 'DIAGNOSE' },
  { href: '/mistakes', labelZh: '错题与复习', shortZh: '复习', group: 'DIAGNOSE' },
  { href: '/vocabulary', labelZh: '词汇', shortZh: '词汇', group: 'DIAGNOSE' },
  { href: '/sentences', labelZh: '句子成分', shortZh: '句子', group: 'DIAGNOSE' },
  { href: '/evidence', labelZh: 'Evidence Center', shortZh: '证据', group: 'DIAGNOSE' },
  { href: '/profile', labelZh: '能力画像', shortZh: '画像', group: 'DIAGNOSE' },
  { href: '/diagnosis', labelZh: '障碍诊断', shortZh: '障碍', group: 'DIAGNOSE' },
  { href: '/retest', labelZh: '复测与迁移', shortZh: '复测', group: 'DIAGNOSE' },
  { href: '/coach', labelZh: 'AI Coach 日志', shortZh: 'AI', group: 'DIAGNOSE' },
  { href: '/general', labelZh: '通用英语', shortZh: '通用', group: 'TRACKS' },
  { href: '/ielts', labelZh: '雅思工作区', shortZh: '雅思', group: 'TRACKS' },
  { href: '/mediated', labelZh: '英语媒介学习', shortZh: '媒介', group: 'TRACKS' },
  { href: '/cycle', labelZh: '90 天周期', shortZh: '周期', group: 'ANALYZE' },
  { href: '/library', labelZh: '方法论资料库', shortZh: '方法', group: 'ANALYZE' },
  { href: '/resources', labelZh: '资源库', shortZh: '资源', group: 'ANALYZE' },
  { href: '/weekly', labelZh: '每周复盘', shortZh: '复盘', group: 'ANALYZE' },
  { href: '/stages', labelZh: '阶段与验收', shortZh: '验收', group: 'ANALYZE' },
  { href: '/settings', labelZh: '系统设置', shortZh: '设置', group: 'ANALYZE' },
];

/** 移动端底部导航只放 5 项，其余进抽屉。 */
export const MOBILE_NAV_HREFS = ['/', '/plan', '/records', '/mistakes', '/settings'];

// ───────────────────────── 阶段 C/D：EGIU 复测与复习中心 ─────────────────────────

/**
 * 复测档位取值集合。
 * 注意 `D0` 是「首测」而不是间隔档，所以它不属于 `IntervalCode`（`IntervalCode` 只描述复习间隔）。
 */
export const REVIEW_STAGE_CODES = [
  'D0',
  'D1',
  'D3',
  'D7',
  'D14',
  'D21',
  'D30',
  'MANUAL',
] as const;

// 类型 `ReviewStageCode` 定义在 `types.ts`（全站 DTO 的唯一来源），这里的元组是真值集合。

export const REVIEW_STAGE_LABEL_ZH: Record<ReviewStageCode, string> = {
  D0: 'D0 首测',
  D1: 'D1 次日回忆',
  D3: 'D3 重做错题',
  D7: 'D7 周抽测',
  D14: 'D14 长期复测',
  D21: 'D21 复测',
  D30: 'D30 月度复测',
  MANUAL: '补测',
};

/** 复习队列分桶：逾期 / 今日 / 未来 7 天。 */
export const REVIEW_BUCKET_WEEK_DAYS = 7;

/** 判定分支文案（`EgiuReview.judgeBranch` 的取值集合）。 */
export const JUDGE_BRANCHES = ['ZERO', 'OVERRIDE', 'FULL', 'LOW_VOLUME'] as const;
// 类型 `JudgeBranch` 定义在 `types.ts`。

export const JUDGE_BRANCH_LABEL_ZH: Record<JudgeBranch, string> = {
  ZERO: '题量为 0',
  OVERRIDE: '硬否决',
  FULL: '题量充足档',
  LOW_VOLUME: '降权档',
};

/** 错题来源。 */
export const MISTAKE_SOURCES = ['EGIU_REVIEW', 'STUDY_RECORD', 'MANUAL', 'VOCAB'] as const;
// 类型 `MistakeSource` 定义在 `types.ts`。

export const MISTAKE_SOURCE_LABEL_ZH: Record<MistakeSource, string> = {
  EGIU_REVIEW: 'EGIU 复测',
  STUDY_RECORD: '学习记录',
  MANUAL: '手动录入',
  VOCAB: '词汇抽测',
};

/** 复习任务结果。 */
export const REVIEW_RESULTS = ['PASS', 'FAIL'] as const;

/** 批量复习操作。 */
export const BATCH_REVIEW_OPS = ['COMPLETE_PASS', 'POSTPONE'] as const;
// 类型 `BatchReviewOp` 定义在 `types.ts`。

export const BATCH_REVIEW_MAX = 200;

// ───────────────────────── 阶段 C/D：周复盘 13 项指标 ─────────────────────────

/**
 * 周复盘 13 项指标的键与中文名（顺序即 UI 顺序）。
 * 这里是**唯一**的指标清单：`domain/weekly.ts` 按这个顺序产出，页面按这个顺序渲染。
 */
export const WEEKLY_METRIC_KEYS = [
  'NET_MINUTES',
  'DAILY_DISTRIBUTION',
  'COMPLETION_RATE',
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'GRAMMAR',
  'COLOR_DELTA',
  'MISTAKES',
  'VOCAB',
  'TOP_ERROR_CATEGORY',
  'WEEK_OVER_WEEK',
] as const;

// 类型 `WeeklyMetricKey` 定义在 `types.ts`。

export const WEEKLY_METRIC_LABEL_ZH: Record<WeeklyMetricKey, string> = {
  NET_MINUTES: '净学习时长',
  DAILY_DISTRIBUTION: '每日时长分布',
  COMPLETION_RATE: '计划完成率（按时长加权）',
  LISTENING: '听力练习',
  READING: '阅读练习',
  SPEAKING: '口语输出',
  WRITING: '写作输出',
  GRAMMAR: '语法（EGIU）诊断',
  COLOR_DELTA: '三色环比变化',
  MISTAKES: '错题与复测',
  VOCAB: '词汇积累与抽测',
  TOP_ERROR_CATEGORY: '主要错误类别',
  WEEK_OVER_WEEK: '净时长环比上周',
};

/** Top3 薄弱点必须选满的个数（PRD 硬要求）。 */
export const WEEKLY_TOP3_COUNT = 3;

// ───────────────────────── 阶段 C/D：句子成分 ─────────────────────────

/** 造句成分标注的最大 token 数（防止误粘贴整篇文章）。 */
export const SENTENCE_MAX_TOKENS = 60;

/** 判定为「标错」时错误原因的最小长度。 */
export const SENTENCE_ERROR_REASON_MIN = 1;

// ───────────────────────── 阶段 D：图表与筛选 ─────────────────────────

/** 分析看板的默认时间窗（天）。 */
export const ANALYTICS_WINDOW_DAYS = 30;
/** 分析看板默认展示的周数。 */
export const ANALYTICS_WEEKS = 8;
/** 折线图至少需要的有效点数，否则走空态（不出零值折线）。 */
export const CHART_MIN_POINTS = 2;

/** 全局筛选：允许出现在 URL 上的 searchParams 键。 */
export const GLOBAL_FILTER_KEYS = ['from', 'to', 'stageId', 'skill', 'resourceId'] as const satisfies readonly GlobalFilterKey[];
// 类型 `GlobalFilterKey` 定义在 `types.ts`。

// ───────────────────────── 阶段 D：AI 预留 ─────────────────────────

export const AI_SCOPES = ['WEAKNESS', 'WEEKLY', 'PLAN'] as const;
// 类型 `AiScope` 定义在 `types.ts`。

/** AI 建议状态（`AiSuggestion.status`）。本版本永远写 `unavailable`。 */
export const AI_STATUSES = ['available', 'unavailable'] as const satisfies readonly AiStatus[];

export const AI_SCOPE_LABEL_ZH: Record<AiScope, string> = {
  WEAKNESS: '薄弱项分析',
  WEEKLY: '周报建议',
  PLAN: '计划调整',
};

export const AI_STATUS_LABEL_ZH: Record<string, string> = {
  available: '已生成',
  unavailable: '未生成',
};

/** AI 建议定位文案（UI 必须原样展示，避免用户把建议当成绩）。 */
export const AI_ROADMAP_NOTE = 'AI 建议为本地规则引擎生成，每条都带「依据（basis）」，仅供参考、不构成成绩，采纳前请自行确认。';

export const NAV_GROUP_LABEL_ZH: Record<NavItem['group'], string> = {
  CORE: '每日执行',
  DIAGNOSE: '诊断与复习',
  TRACKS: '三轨道',
  ANALYZE: '复盘与配置',
};

// ───────────────────────── 阶段 C/D：列表与表单上限 ─────────────────────────

/** 错题「高频知识点」榜单条数。 */
export const MISTAKE_TOP_KNOWLEDGE_POINTS = 8;
/** 单个 token 的文本长度上限（防止整段粘贴）。 */
export const SENTENCE_TOKEN_TEXT_MAX = 80;
/** 句子原文长度上限。 */
export const SENTENCE_TEXT_MAX = 500;
/** 周复盘备注长度上限。 */
export const WEEKLY_NOTE_MAX = 4000;
/** 领域导出类别（T33 补齐的五类）。 */
export const DOMAIN_EXPORT_KINDS = [
  'grammar',
  'mistakes',
  'vocab',
  'sentences',
  'reviews',
] as const;


// ═════════════════════════════════════════════════════════════════════════════
// v2.0 三轨道
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 三条学习轨道。**顺序即 Dashboard 展示顺序**。
 *
 * 硬约束：`ENGLISH_MEDIATED_LEARNING` 是跨技能应用，不是第五项语言技能 ——
 * 它出现在这里（轨道维度）但**绝不出现在 `ALLOCATION_SKILLS`**（技能维度）。
 */
export const LEARNING_TRACKS: LearningTrack[] = [
  'GENERAL_ENGLISH',
  'IELTS_PREPARATION',
  'ENGLISH_MEDIATED_LEARNING',
];

export const TRACK_LABEL_ZH: Record<LearningTrack, string> = {
  GENERAL_ENGLISH: 'General English',
  IELTS_PREPARATION: 'IELTS Preparation',
  ENGLISH_MEDIATED_LEARNING: 'English-mediated Learning',
};

/** 轨道一句话定位（UI 副标题，避免用户误解三者关系）。 */
export const TRACK_SUBTITLE_ZH: Record<LearningTrack, string> = {
  GENERAL_ENGLISH: '长期综合能力 · 目标 B2 左右',
  IELTS_PREPARATION: '阶段性考试 · 目标可配置',
  ENGLISH_MEDIATED_LEARNING: '用英语学法语及其他知识 · 跨技能应用',
};

/**
 * 四技能专项训练 + 支持性模块。
 *
 * `FOUNDATION` 是「词汇 / 语法 / 句子 / 复盘 / 泛练」的归集桶，
 * **不进入四技能配比分母**（SOP v2 §2 原文：词汇、语法、发音讲解、复盘和工具学习
 * 不进入该比例的分母）。
 */
export const PRIMARY_SKILLS: PrimarySkill[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'FOUNDATION',
];

/**
 * **参与四技能配比的技能集合**。配比分母 = 这四项分钟之和。
 * 顺序即展示顺序（L → R → S → W）。
 */
export const ALLOCATION_SKILLS: AllocationSkill[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
];

export const PRIMARY_SKILL_LABEL_ZH: Record<PrimarySkill, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  FOUNDATION: '支持性模块',
};

/** 阶段 profile 编码与中文名（SOP v2 §2 阶段表）。 */
export const STAGE_PROFILE_CODES: StageProfileCode[] = [
  'PREPARATION',
  'A0_A2',
  'A2_B1',
  'B1_B2',
  'IELTS_INTENSIVE',
];

export const STAGE_PROFILE_LABEL_ZH: Record<StageProfileCode, string> = {
  PREPARATION: '准备与基线诊断',
  A0_A2: 'A0 → A2 基础英语',
  A2_B1: 'A2 → B1 中级英语',
  B1_B2: 'B1 → B2 / IELTS',
  IELTS_INTENSIVE: 'IELTS 冲刺',
};

/**
 * 阶段 → 内置配比（SOP v2 §2 表格原文，**数值不可改**）。
 *
 * | 阶段 | L | R | S | W |
 * | A0–A2 | 30 | 30 | 25 | 15 |
 * | A2–B1 | 28 | 27 | 25 | 20 |
 * | B1–B2 | 25 | 25 | 25 | 25 |
 *
 * `PREPARATION` 沿用 A0–A2 基准（SOP 未单列，取最早阶段口径）。
 * `IELTS_INTENSIVE` 无内置值 —— 必须由用户配置，见 `DEFAULT_IELTS_INTENSIVE`。
 */
export const STAGE_ALLOCATION: Record<StageProfileCode, SkillAllocation> = {
  PREPARATION: { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 },
  A0_A2: { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 },
  A2_B1: { LISTENING: 28, READING: 27, SPEAKING: 25, WRITING: 20 },
  B1_B2: { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 },
  IELTS_INTENSIVE: { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 },
};

/** 配比合计必须等于该值（硬校验，不等于即拒绝保存）。 */
export const ALLOCATION_SUM = 100;

/** 单项占比允许的最小值（防止把某技能配成 0，等于放弃训练）。 */
export const ALLOCATION_MIN_PCT = 5;

/** 单项占比允许的最大值。 */
export const ALLOCATION_MAX_PCT = 60;

/**
 * 配平后单项技能的**可实施下限分钟数**。
 *
 * 为什么需要：写作配比 15%，在四项总预算 105min 时理论值为 15.75min，
 * 取整可能落到 1 分钟甚至 0 —— 0 分钟意味着这条任务直接消失，
 * 而「本周零写作训练」和「写作配比不足」是两件完全不同的事。
 * 下限保证每项技能每天都留下一条可执行、可记录的任务。
 */
export const ALLOCATION_MIN_MINUTES = 10;

/** 现有 Stage.code → profileCode 的映射（seed 与迁移共用）。 */
export const STAGE_CODE_TO_PROFILE: Record<StageCode, StageProfileCode> = {
  S0_PREP: 'PREPARATION',
  S1_A0_A2: 'A0_A2',
  S2_A2_B1: 'A2_B1',
  S3_B1_IELTS: 'B1_B2',
};

/** 目标类型与中文名。 */
export const GOAL_TYPES: GoalType[] = ['GENERAL_ENGLISH', 'IELTS', 'ENGLISH_MEDIATED_LEARNING'];

export const GOAL_TYPE_LABEL_ZH: Record<GoalType, string> = {
  GENERAL_ENGLISH: '通用英语能力',
  IELTS: 'IELTS 阶段目标',
  ENGLISH_MEDIATED_LEARNING: '英语媒介学习能力',
};

/** 目标进入的页面（Dashboard 目标卡跳转用）。 */
export const GOAL_HREF: Record<GoalType, string> = {
  GENERAL_ENGLISH: '/general',
  IELTS: '/ielts',
  ENGLISH_MEDIATED_LEARNING: '/mediated',
};

export const GOAL_STATUSES: GoalStatus[] = ['ACTIVE', 'ACHIEVED', 'PAUSED'];

export const GOAL_STATUS_LABEL_ZH: Record<GoalStatus, string> = {
  ACTIVE: '进行中',
  ACHIEVED: '已达成',
  PAUSED: '已暂停',
};

export const MILESTONE_STATUSES: MilestoneStatus[] = ['PENDING', 'ACHIEVED', 'FAILED'];

export const MILESTONE_STATUS_LABEL_ZH: Record<MilestoneStatus, string> = {
  PENDING: '待达成',
  ACHIEVED: '已达成',
  FAILED: '未达成',
};

/** CEFR 等级（有序，用于比较与展示）。 */
export const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

/** 等级数值（比较用）。 */
export const CEFR_RANK: Record<CefrLevel, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5 };

export const ASSESSMENT_TYPES: AssessmentType[] = ['SELF', 'TEST', 'EXTERNAL', 'AI_ESTIMATE'];

export const ASSESSMENT_TYPE_LABEL_ZH: Record<AssessmentType, string> = {
  SELF: '自评',
  TEST: '测试',
  EXTERNAL: '外部反馈',
  AI_ESTIMATE: 'AI 估计',
};

export const ASSESSOR_KINDS: AssessorKind[] = ['SELF', 'TEACHER', 'EXAM', 'AI', 'OTHER'];

export const ASSESSOR_LABEL_ZH: Record<AssessorKind, string> = {
  SELF: '本人',
  TEACHER: '教师',
  EXAM: '考试机构',
  AI: 'AI',
  OTHER: '其他',
};

/** 置信度 1..5。 */
export const CONFIDENCE_MIN = 1;
export const CONFIDENCE_MAX = 5;
export const CONFIDENCE_DEFAULT = 3;

export const IELTS_TEST_TYPES: IeltsTestType[] = ['OFFICIAL', 'MOCK', 'PRACTICE'];

export const IELTS_TEST_TYPE_LABEL_ZH: Record<IeltsTestType, string> = {
  OFFICIAL: '正式考试',
  MOCK: '模考',
  PRACTICE: '单项练习',
};

/** IELTS band 合法范围（0.0–9.0，0.5 步进）。 */
export const IELTS_BAND_MIN = 0;
export const IELTS_BAND_MAX = 9;
export const IELTS_BAND_STEP = 0.5;

/**
 * 阶段 gate 需要「最近 N 次有效模考」才能判定 IELTS 达标（SOP v2 §8.3）。
 * 单次成绩不足以判定，必须稳定。
 */
export const IELTS_GATE_MIN_RECORDS = 2;
export const IELTS_GATE_MAX_RECORDS = 3;

/** 通用英语 gate 要求每项技能至少有 N 条评估证据（防「只学听力就升 B2」）。 */
export const GE_GATE_MIN_ASSESSMENTS_PER_SKILL = 1;

/** 媒介学习 gate：A2–B1 试学阶段的最小记录次数。 */
export const MEDIATED_GATE_MIN_SESSIONS_TRIAL = 3;
/** 媒介学习 gate：B1 之后系统化阶段的最小记录次数。 */
export const MEDIATED_GATE_MIN_SESSIONS_SYSTEMATIC = 6;

export const MEDIATED_UNDERSTANDINGS: MediatedUnderstanding[] = ['FULL', 'PARTIAL', 'LOW'];

export const MEDIATED_UNDERSTANDING_LABEL_ZH: Record<MediatedUnderstanding, string> = {
  FULL: '能说出主旨与例子',
  PARTIAL: '需字幕/翻译辅助',
  LOW: '无法理解',
};

/** 理解度得分（gate 判定用；LOW 不计入有效证据）。 */
export const UNDERSTANDING_SCORE: Record<MediatedUnderstanding, number> = {
  FULL: 1,
  PARTIAL: 0.6,
  LOW: 0,
};

export const TRANSLATION_DEPENDENCIES: TranslationDependency[] = [
  'NONE',
  'SUBTITLE_EN',
  'ZH_ASSIST',
  'HEAVY_ZH',
];

export const TRANSLATION_DEPENDENCY_LABEL_ZH: Record<TranslationDependency, string> = {
  NONE: '不依赖翻译',
  SUBTITLE_EN: '依赖英文字幕',
  ZH_ASSIST: '需中文辅助',
  HEAVY_ZH: '高度依赖中文',
};

/**
 * 翻译依赖得分（越高越独立）。gate 要求「依赖明显下降」，
 * 即最近 N 次均值 > 基线均值，或均值 ≥ `MEDIATED_INDEPENDENCE_PASS`。
 */
export const TRANSLATION_INDEPENDENCE_SCORE: Record<TranslationDependency, number> = {
  NONE: 1,
  SUBTITLE_EN: 0.7,
  ZH_ASSIST: 0.4,
  HEAVY_ZH: 0.1,
};

/** 媒介学习「独立性达标」阈值（均值 ≥ 0.7 = 至少英文字幕级别）。 */
export const MEDIATED_INDEPENDENCE_PASS = 0.7;

/**
 * 媒介学习「理解度达标」阈值（均值 ≥ 0.6 = 至少「部分理解 / 需字幕辅助」）。
 *
 * 低于此值说明这一次并没有真正「用英语学知识」，而是在猜。
 */
export const MEDIATED_UNDERSTANDING_PASS = 0.6;

/**
 * 浮点比较容差（用于「均值是否达到阈值」类判断）。
 *
 * 起因：`0.7 + 0.7 + 0.7 + 0.7` 之和在 IEEE754 下是 `2.7999999999999998`，
 * 除以 4 得 `0.6999999999999999` < 0.7 —— 恰好达标的记录会被误判为不达标。
 * 所有「均值 ≥ 阈值」「占比 = 目标」类比较都必须带上这个容差。
 */
export const FLOAT_EPSILON = 1e-9;

export const MEDIATED_INTENSITIES: MediatedIntensity[] = ['PRE_A2', 'A2_B1', 'B1_PLUS'];

export const MEDIATED_INTENSITY_LABEL_ZH: Record<MediatedIntensity, string> = {
  PRE_A2: '术语接触（A0–A2）',
  A2_B1: '低强度试学（A2–B1）',
  B1_PLUS: '系统化（B1 之后）',
};

/** 各阶段建议的媒介学习强度档。 */
export const MEDIATED_INTENSITY_BY_PROFILE: Record<StageProfileCode, MediatedIntensity> = {
  PREPARATION: 'PRE_A2',
  A0_A2: 'PRE_A2',
  A2_B1: 'A2_B1',
  B1_B2: 'B1_PLUS',
  IELTS_INTENSIVE: 'B1_PLUS',
};

export const SOURCE_TYPES = ['COURSE', 'VIDEO', 'TEXTBOOK', 'ARTICLE', 'PODCAST', 'OTHER'] as const;

export const SOURCE_TYPE_LABEL_ZH: Record<string, string> = {
  COURSE: '课程',
  VIDEO: '视频',
  TEXTBOOK: '教材',
  ARTICLE: '文章',
  PODCAST: '播客',
  OTHER: '其他',
};

export const OUTPUT_TYPES: OutputType[] = [
  'NOTE_EN',
  'SUMMARY_EN',
  'QUESTION_EN',
  'ESSAY',
  'RECORDING',
  'MINDMAP',
];

export const OUTPUT_TYPE_LABEL_ZH: Record<OutputType, string> = {
  NOTE_EN: '英文笔记',
  SUMMARY_EN: '英文摘要',
  QUESTION_EN: '英文提问',
  ESSAY: '写作',
  RECORDING: '录音',
  MINDMAP: '思维导图',
};

/** 媒介学习「有效产出」类型（gate 与统计用）。 */
export const MEDIATED_EVIDENCE_OUTPUTS: OutputType[] = ['NOTE_EN', 'SUMMARY_EN', 'QUESTION_EN'];

export const OUTPUT_REVIEW_STATUSES = ['DRAFT', 'REVIEWED', 'ACCEPTED'] as const;

export const EVIDENCE_TYPES: EvidenceType[] = [
  'RECORDING',
  'WRITING',
  'SCORE_SHEET',
  'COURSE_MATERIAL',
  'SCREENSHOT',
  'OTHER',
];

export const EVIDENCE_TYPE_LABEL_ZH: Record<EvidenceType, string> = {
  RECORDING: '录音',
  WRITING: '写作文本',
  SCORE_SHEET: '评分单',
  COURSE_MATERIAL: '课程材料',
  SCREENSHOT: '截图',
  OTHER: '其他',
};

export const EVIDENCE_ENTITIES: EvidenceEntity[] = [
  'SKILL_ASSESSMENT',
  'IELTS_ASSESSMENT',
  'MEDIATED_SESSION',
  'STUDY_RECORD',
  'GOAL_MILESTONE',
];

/** 各技能的时间统计单位（展示文案用）。 */
export const MEDIATED_DEFAULT_SUBJECT = 'French';

/** 媒介学习摘要最小长度（「能产出摘要」的最低门槛）。 */
export const MEDIATED_SUMMARY_MIN_CHARS = 40;

/** SkillId → PrimarySkill 的映射（旧数据迁移与任务生成共用）。 */
export const SKILL_TO_PRIMARY: Record<SkillId, PrimarySkill> = {
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
  LISTENING_EXT: 'LISTENING',
  READING_EXT: 'READING',
  VOCAB: 'FOUNDATION',
  GRAMMAR: 'FOUNDATION',
  SENTENCE: 'FOUNDATION',
  META: 'FOUNDATION',
  // 媒介学习是跨技能应用：它的 PrimarySkill 由**该次记录**决定（L/R/S/W 之一），
  // 因此这个静态映射只在「未指定时的兜底」路径使用，不参与真实统计。
  MEDIATED: 'FOUNDATION',
};

/** 模块 → 主技能（生成计划时用；`MEDIATED` 需按记录选择，故不在表内）。 */
export const MODULE_TO_PRIMARY: Record<ModuleId, PrimarySkill> = {
  VOCAB_REVIEW: 'FOUNDATION',
  GRAMMAR: 'FOUNDATION',
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
  SENTENCE: 'FOUNDATION',
  REVIEW_PLAN: 'FOUNDATION',
  EXTENSIVE: 'FOUNDATION',
  MEDIATED: 'FOUNDATION',
  P0_REVIEW: 'FOUNDATION',
  BASELINE_LISTEN: 'LISTENING',
  BASELINE_READ: 'READING',
  BASELINE_OUTPUT: 'SPEAKING',
  EVIDENCE_RETEST: 'FOUNDATION',
};

/** 模块 → 轨道（`MEDIATED` 恒属媒介轨道）。 */
export const MODULE_TRACK: Record<ModuleId, LearningTrack> = {
  VOCAB_REVIEW: 'GENERAL_ENGLISH',
  GRAMMAR: 'GENERAL_ENGLISH',
  LISTENING: 'GENERAL_ENGLISH',
  READING: 'GENERAL_ENGLISH',
  SPEAKING: 'GENERAL_ENGLISH',
  WRITING: 'GENERAL_ENGLISH',
  SENTENCE: 'GENERAL_ENGLISH',
  REVIEW_PLAN: 'GENERAL_ENGLISH',
  EXTENSIVE: 'GENERAL_ENGLISH',
  MEDIATED: 'ENGLISH_MEDIATED_LEARNING',
  P0_REVIEW: 'GENERAL_ENGLISH',
  BASELINE_LISTEN: 'GENERAL_ENGLISH',
  BASELINE_READ: 'GENERAL_ENGLISH',
  BASELINE_OUTPUT: 'GENERAL_ENGLISH',
  EVIDENCE_RETEST: 'GENERAL_ENGLISH',
};

/**
 * 学习记录科目 → 轨道（记录没有 module，只能按科目推导）。
 *
 * 注意与 `MODULE_TRACK` 的区别：那张表按模块推导，这张按记录科目推导。
 * 两者默认都落到 GENERAL_ENGLISH —— 记录表单允许用户显式改轨道（例如把一次
 * 阅读记录挂到 IELTS 备考），此时以用户传入值为准。
 */
export const SKILL_TRACK: Record<SkillId, LearningTrack> = {
  LISTENING: 'GENERAL_ENGLISH',
  READING: 'GENERAL_ENGLISH',
  SPEAKING: 'GENERAL_ENGLISH',
  WRITING: 'GENERAL_ENGLISH',
  VOCAB: 'GENERAL_ENGLISH',
  GRAMMAR: 'GENERAL_ENGLISH',
  SENTENCE: 'GENERAL_ENGLISH',
  META: 'GENERAL_ENGLISH',
  LISTENING_EXT: 'GENERAL_ENGLISH',
  READING_EXT: 'GENERAL_ENGLISH',
  MEDIATED: 'ENGLISH_MEDIATED_LEARNING',
};

// ───────────────────────── v2.2 证据域 ─────────────────────────

/** 证据可覆盖的技能（与画像四技能分开展示，GRAMMAR/VOCABULARY 仅知识型证据）。 */
export const EVIDENCE_SKILLS: EvidenceSkill[] = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
  'GRAMMAR',
  'VOCABULARY',
];

export const EVIDENCE_SKILL_LABEL_ZH: Record<EvidenceSkill, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
  GRAMMAR: '语法',
  VOCABULARY: '词汇',
};

/** 四技能（分项画像只用这四项，且不取平均）。 */
export const PROFILE_SKILLS: Array<'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING'> = [
  'LISTENING',
  'READING',
  'SPEAKING',
  'WRITING',
];

/** 证据类型（E0–E5）。顺序即生命周期顺序。 */
export const LEARNING_EVIDENCE_TYPES: LearningEvidenceType[] = [
  'BASELINE',
  'ASSISTED',
  'IMMEDIATE_RETEST',
  'DELAYED_RETEST',
  'APPLIED_TASK',
  'TRANSFER',
];

export const LEARNING_EVIDENCE_TYPE_LABEL_ZH: Record<LearningEvidenceType, string> = {
  BASELINE: '首版基线',
  ASSISTED: '辅助学习版',
  IMMEDIATE_RETEST: '即时复测',
  DELAYED_RETEST: '延迟复测',
  APPLIED_TASK: '实际应用',
  TRANSFER: '迁移验证',
};

/** 生命周期编码（展示用）。 */
export const LEARNING_EVIDENCE_TYPE_CODE: Record<LearningEvidenceType, string> = {
  BASELINE: 'E0',
  ASSISTED: 'E1',
  IMMEDIATE_RETEST: 'E2',
  DELAYED_RETEST: 'E3',
  APPLIED_TASK: 'E4',
  TRANSFER: 'E5',
};

export const EVIDENCE_LEVELS: EvidenceLevel[] = ['QUICK', 'STANDARD', 'FULL'];

export const EVIDENCE_LEVEL_LABEL_ZH: Record<EvidenceLevel, string> = {
  QUICK: 'Quick 轻量',
  STANDARD: 'Standard 阶段',
  FULL: 'Full 完整链',
};

/** 各级别最少要记录的字段说明（用于表单提示，不强制在 schema 层锁死）。 */
export const EVIDENCE_LEVEL_HINT_ZH: Record<EvidenceLevel, string> = {
  QUICK: '目标技能、材料、净时长、一个可见产出、一个问题或感受。',
  STANDARD: '任务、原始结果、辅助情况、错误类别、修复动作、即时复测。',
  FULL: 'E0–E5 版本关系、条件、评价维度、证据位置、外部反馈、迁移结论。',
};

export const ASSISTANCE_LEVELS: AssistanceLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];

export const ASSISTANCE_LEVEL_LABEL_ZH: Record<AssistanceLevel, string> = {
  A0: 'A0 无辅助',
  A1: 'A1 轻辅助（词义/播放/拼写）',
  A2: 'A2 结构提示',
  A3: 'A3 详细反馈/局部修改',
  A4: 'A4 代写/代答/完整改写',
};

/** 只有 A0 才算独立表现；A4 绝不计为学习者独立产出。 */
export const INDEPENDENT_ASSISTANCE_LEVEL: AssistanceLevel = 'A0';
export const AI_SUBSTITUTE_ASSISTANCE_LEVEL: AssistanceLevel = 'A4';

export const EVIDENCE_CONFIDENCES: EvidenceConfidence[] = ['LOW', 'MEDIUM', 'HIGH'];

export const EVIDENCE_CONFIDENCE_LABEL_ZH: Record<EvidenceConfidence, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
};

export const ASSESSOR_TYPES: AssessorType[] = ['SELF', 'TEACHER', 'PEER', 'AI', 'EXAM'];

export const ASSESSOR_TYPE_LABEL_ZH: Record<AssessorType, string> = {
  SELF: '自评',
  TEACHER: '教师',
  PEER: '同伴/听众',
  AI: 'AI 反馈',
  EXAM: '考试/官方',
};

export const EVIDENCE_PRIVACY_LEVELS: EvidencePrivacy[] = [
  'PRIVATE',
  'SHAREABLE',
  'METADATA_ONLY',
];

export const EVIDENCE_PRIVACY_LABEL_ZH: Record<EvidencePrivacy, string> = {
  PRIVATE: '仅自己可见',
  SHAREABLE: '可分享',
  METADATA_ONLY: '只存元数据',
};

export const SKILL_DIRECTIONS: SkillDirection[] = [
  'Pre-A1',
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
];

/** 内部 0–2 证据评分：仅供同一学习者纵向比较，不是官方等级。 */
export const EVIDENCE_SCORE_MIN = 0;
export const EVIDENCE_SCORE_MAX = 2;

export const EVIDENCE_SCORE_LABEL_ZH: Record<number, string> = {
  0: '未完成/无证据',
  1: '部分完成或依赖帮助',
  2: '在标明条件下独立完成',
};

/** 输出预览截断长度（列表页）。 */
export const EVIDENCE_OUTPUT_PREVIEW_CHARS = 140;

// ───────────────────────── 障碍诊断 ─────────────────────────

export const BARRIER_TYPES_BY_SKILL: Record<EvidenceSkill, string[]> = {
  LISTENING: [
    'VOCABULARY',
    'SOUND_SEGMENTATION',
    'SYNTAX',
    'BACKGROUND',
    'ATTENTION_LOAD',
    'DEVICE_ENV',
  ],
  READING: [
    'VOCAB_DENSITY',
    'SENTENCE_STRUCTURE',
    'REFERENCE_COHESION',
    'CLAIM_EVIDENCE',
    'BACKGROUND_FORMAT',
  ],
  SPEAKING: [
    'LEXICAL_RETRIEVAL',
    'PRONUNCIATION',
    'FLUENCY_ORGANIZATION',
    'INTERACTION',
    'REPAIR_REGISTER',
  ],
  WRITING: [
    'TASK_AUDIENCE',
    'FACTUAL_ACCURACY',
    'ORGANIZATION',
    'SENTENCE_GRAMMAR',
    'LEXICAL_REGISTER',
    'REVISION_DEPENDENCE',
  ],
  GRAMMAR: [
    'RULE_RECOGNITION',
    'RULE_EXPLANATION',
    'CONTROLLED_USE',
    'INDEPENDENT_USE',
    'DELAYED_RETENTION',
  ],
  VOCABULARY: ['RECEPTIVE_GAP', 'PRODUCTIVE_GAP', 'COLLOCATION_GAP'],
};

export const BARRIER_TYPE_LABEL_ZH: Record<string, string> = {
  VOCABULARY: '词汇（词形与意思都陌生）',
  SOUND_SEGMENTATION: '声音/词界切分（认识词但听不出）',
  SYNTAX: '句法（无法建立句间/从句关系）',
  BACKGROUND: '背景知识',
  ATTENTION_LOAD: '注意/负荷（长度、速度、密度过高）',
  DEVICE_ENV: '设备/环境（先排除技术因素）',
  VOCAB_DENSITY: '生词密度',
  SENTENCE_STRUCTURE: '句子结构（找主干/逻辑）',
  REFERENCE_COHESION: '指代与衔接',
  CLAIM_EVIDENCE: '主张/证据/推断混淆',
  BACKGROUND_FORMAT: '背景知识或文档格式',
  LEXICAL_RETRIEVAL: '词汇提取（有想法找不到词块）',
  PRONUNCIATION: '发音/可理解度',
  FLUENCY_ORGANIZATION: '流利度与组织',
  INTERACTION: '互动（无法处理追问）',
  REPAIR_REGISTER: '修复与语域',
  TASK_AUDIENCE: '任务目的/受众',
  FACTUAL_ACCURACY: '事实准确性',
  ORGANIZATION: '段落组织',
  SENTENCE_GRAMMAR: '句子/语法',
  LEXICAL_REGISTER: '词汇范围/语域',
  REVISION_DEPENDENCE: '修订依赖（AI 改得好但独立写不出）',
  RULE_RECOGNITION: '规则识别',
  RULE_EXPLANATION: '规则解释',
  CONTROLLED_USE: '控制性使用',
  INDEPENDENT_USE: '独立使用',
  DELAYED_RETENTION: '延迟保持',
  RECEPTIVE_GAP: '听读识别不足',
  PRODUCTIVE_GAP: '说写主动调用不足',
  COLLOCATION_GAP: '搭配与用法',
};

export const INTERVENTION_STATUSES = ['PLANNED', 'RUNNING', 'DONE', 'ABANDONED'] as const;
export const INTERVENTION_STATUS_LABEL_ZH: Record<string, string> = {
  PLANNED: '待执行',
  RUNNING: '进行中',
  DONE: '已完成',
  ABANDONED: '已放弃',
};

/** 每轮只聚焦一个主要障碍（UI 层的约束提示）。 */
export const BARRIER_FOCUS_PER_CYCLE = 1;

export const BARRIER_STATUSES: BarrierStatus[] = ['ACTIVE', 'RESOLVED', 'SUPERSEDED'];

export const BARRIER_STATUS_LABEL_ZH: Record<BarrierStatus, string> = {
  ACTIVE: '诊断中',
  RESOLVED: '已解决',
  SUPERSEDED: '已替代',
};

export const BARRIER_IMPACT_MIN_CHARS = 4;
export const INTERVENTION_ACTION_MIN_CHARS = 6;
export const INTERVENTION_CRITERIA_MIN_CHARS = 8;

/** 修复期默认允许的支架级别：A1（轻辅助）；复测时必须撤回到 A0。 */
export const INTERVENTION_DEFAULT_SCAFFOLD: AssistanceLevel = 'A1';

/** A4 是代写/代答，不能作为「修复支架」——那会把练习变成系统代替学习者完成。 */
export const INTERVENTION_FORBIDDEN_SCAFFOLD: AssistanceLevel = 'A4';

/** 各技能修复动作与成功标准模板；只是起点，用户必须按自己的证据改写。 */
export const BARRIER_REPAIR_PRESET_ZH: Record<
  EvidenceSkill,
  { action: string; successCriteria: string; minutes: number }
> = {
  LISTENING: {
    action:
      '用同一材料的 60–90 秒片段做逐句听写：先盲听一遍写下听到的内容，再对照原文标出切分失败处，最后重听该句。',
    successCriteria:
      '换一段同难度平行材料，能在不暂停的情况下写出关键信息点（不少于 3 处），并口头说明失败句的意思。',
    minutes: 15,
  },
  READING: {
    action:
      '对一段 150–250 词文本做「主干标注」：每句只标主语+谓语+核心宾语，再回答一个作者主张/证据问题。',
    successCriteria:
      '换一段平行文本，在不查词的前提下 3 分钟内找出每段主张句，并用自己的话概括证据如何支持主张。',
    minutes: 20,
  },
  SPEAKING: {
    action:
      '针对一个熟悉话题做 30 秒准备 + 60 秒独白录音，回听只标「卡住/找不到词」的位置，再用词块重说同一段。',
    successCriteria:
      '换一个话题，能在 60 秒内连续表达且停顿不超过 3 处；回听能指出至少 2 个已修复的词块。',
    minutes: 15,
  },
  WRITING: {
    action:
      '就一个具体任务写 80–120 词，写完先自评任务要求覆盖了几项，再只改一类问题（结构 / 语法 / 用词）。',
    successCriteria:
      '换一个新任务，30 分钟内独立写出结构完整段落；对照成功标准逐项自查，无需 AI 重写即可达标。',
    minutes: 25,
  },
  GRAMMAR: {
    action:
      '针对一个结构做「识别→解释→造句」三步练习：先标出给定句子中的目标结构，再说明它表达什么，最后自己造 3 句。',
    successCriteria:
      '换 10 个新句子，能识别并解释目标结构，且自己造的 3 句在无提示情况下语法正确。',
    minutes: 15,
  },
  VOCABULARY: {
    action:
      '选 10 个目标词块：先做听读识别，再在真实句子中主动调用（说或写），最后回看哪些词只在识别层面熟悉。',
    successCriteria: '间隔复测时能主动说出/写出其中至少 7 个词块，并放进完整句子。',
    minutes: 15,
  },
};

/** 诊断页顶部口径提示。 */
export const BARRIER_FOCUS_NOTE_ZH =
  '每轮只聚焦一个主要障碍；其他障碍先记录不展开。修复计划复测时必须撤回支架（A1–A3），只有 A0 才算独立表现。';


// ───────────────────────── 复测与迁移 ─────────────────────────

export const RETEST_TYPES: RetestType[] = ['IMMEDIATE', 'DELAYED', 'APPLIED', 'TRANSFER'];

export const RETEST_TYPE_LABEL_ZH: Record<RetestType, string> = {
  IMMEDIATE: '即时复测',
  DELAYED: '延迟复测（平行材料）',
  APPLIED: '实际应用',
  TRANSFER: '迁移验证（新条件）',
};

/** 相对父证据创建日的偏移天数。知识型复习仍走 ReviewTask（1/3/7/14）。 */
export const RETEST_OFFSET_DAYS: Record<RetestType, number> = {
  IMMEDIATE: 0,
  DELAYED: 7,
  APPLIED: 30,
  TRANSFER: 84,
};

export const RETEST_DEFAULT_MINUTES: Record<RetestType, number> = {
  IMMEDIATE: 10,
  DELAYED: 15,
  APPLIED: 20,
  TRANSFER: 25,
};

export const RETEST_STATUSES: RetestStatus[] = ['PENDING', 'DONE', 'SKIPPED', 'SUPERSEDED'];

export const RETEST_STATUS_LABEL_ZH: Record<RetestStatus, string> = {
  PENDING: '待完成',
  DONE: '已完成',
  SKIPPED: '已跳过',
  SUPERSEDED: '已被替代',
};

/** 默认只为基线/阶段证据排复测；Quick 日常证据不自动排链。 */
export const RETEST_AUTO_PARENT_TYPES: LearningEvidenceType[] = [
  'BASELINE',
  'IMMEDIATE_RETEST',
  'DELAYED_RETEST',
];

/** 复测任务排入当日计划时使用的模块。 */
export const RETEST_PLAN_MODULE = 'EVIDENCE_RETEST';
export const RETEST_PLAN_PRIORITY = 1;

/** 复测页口径提示：技能复测与知识复习是两套队列。 */
export const RETEST_QUEUE_NOTE_ZH =
  '技能型复测按证据链排期（D0 即时 / D7 延迟 / D30 实际应用 / D84 迁移验证）；知识型错题与词汇仍走复习中心，两套状态互不复用。';

/** 迁移验证的硬规则提示。 */
export const RETEST_TRANSFER_NOTE_ZH =
  '重做原题只能记为「实际应用」；迁移验证必须换新题/新材料或新情境，否则不算迁移。';

/** 复测必须撤除支架。 */
export const RETEST_A0_NOTE_ZH = '复测必须无辅助（A0）完成；A1–A4 只能算练习，不能标记复测完成。';

// ───────────────────────── 90 天周期 ─────────────────────────

export const CYCLE_TOTAL_DAYS = 90;
export const CYCLE_CALIBRATION_END_DAY = 14;
export const CYCLE_BUILD_END_DAY = 56;

export const CYCLE_PHASES: CyclePhaseCode[] = ['CALIBRATION', 'BUILD', 'DELIVER'];

export const CYCLE_PHASE_LABEL_ZH: Record<CyclePhaseCode, string> = {
  CALIBRATION: '校准（第 1–14 天）',
  BUILD: '积累（第 15–56 天）',
  DELIVER: '交付（第 57–90 天）',
};

export const CYCLE_PHASE_ADVICE_ZH: Record<CyclePhaseCode, string> = {
  CALIBRATION: '确认真实目标、L/R/S/W 基线、主要障碍和每周可持续时间。',
  BUILD: '围绕一个主要障碍定向训练；每周一个可观察问题，保留多次输出和反馈。',
  DELIVER: '换材料/主题/受众或进入真实场景，完成独立交付和迁移验证。',
};

/** 进入积累阶段的证据门槛：至少 4 次可比较输出。 */
export const CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS = 4;

export const CYCLE_STATUSES: CycleStatus[] = [
  'CALIBRATION',
  'BUILD',
  'DELIVER',
  'COMPLETED',
  'PAUSED',
];

export const CYCLE_STATUS_LABEL_ZH: Record<CycleStatus, string> = {
  CALIBRATION: '校准中',
  BUILD: '积累中',
  DELIVER: '交付中',
  COMPLETED: '已完成',
  PAUSED: '已暂停',
};

/** 周复盘默认时长（分钟）。 */
export const WEEKLY_REVIEW_MINUTES = 20;

/** 中断恢复：给出 24 小时内可完成的最小下一步。 */
export const RECOVERY_NEXT_STEP_HOURS = 24;

/** 周期内周数（90 天按整周向上取整 = 13 周）。 */
export const CYCLE_WEEKS = Math.ceil(CYCLE_TOTAL_DAYS / 7);

/** 中断恢复建议的最小下一步时长（分钟），低于日常任务量。 */
export const RECOVERY_MINIMAL_MINUTES = 15;

/** 可比较输出口径：Quick 记录只算日常痕迹，不计入阶段门槛。 */
export const CYCLE_COMPARABLE_NOTE_ZH =
  '可比较输出 = 标准或完整级（非 Quick）、带产出原文、未归档的证据；Quick 轻量记录不计入阶段门槛。';

/** 阶段推进门槛说明。 */
export const CYCLE_PHASE_GATE_NOTE_ZH = `进入积累阶段需 ≥ ${CYCLE_BUILD_MIN_COMPARABLE_OUTPUTS} 次可比较输出；进入交付阶段需 ≥ 1 条实际应用或迁移验证证据。`;

/** 中断恢复口径：不补积压、不合并缺周。 */
export const CYCLE_RECOVERY_NOTE_ZH =
  '中断恢复：先写客观原因，再选 24 小时内能完成的最小下一步；不补做积压任务，也不合并缺失的周。';

/** 每周主问题口径。 */
export const CYCLE_FOCUS_NOTE_ZH =
  '每周只保留一个主问题：一项输入、一项输出、一次反馈、一项迁移证据；问题不扩展成清单。';

/** 缺周处理口径。 */
export const CYCLE_NO_BACKLOG_NOTE_ZH = '缺周的记录不补排、不合并，直接从本周重新开始。';

export const WEEKLY_FOCUS_STATUSES: WeeklyFocusStatus[] = ['OPEN', 'REVIEWED'];

export const WEEKLY_FOCUS_STATUS_LABEL_ZH: Record<WeeklyFocusStatus, string> = {
  OPEN: '进行中',
  REVIEWED: '已复盘',
};

export const WEEKLY_FOCUS_SLOT_LABEL_ZH: Record<WeeklyFocusSlot, string> = {
  question: '一个主问题',
  input: '一项输入',
  output: '一项输出',
  feedback: '一次反馈',
  transfer: '一项迁移证据',
  decision: '下周决定',
};

// ───────────────────────── AI 使用日志 ─────────────────────────

export const AI_ACTION_TYPES: AIActionType[] = [
  'HINT',
  'EXPLAIN',
  'CORRECT',
  'REWRITE',
  'GENERATE',
  'SCORE',
  'TRANSLATE',
  'OTHER',
];

export const AI_ACTION_TYPE_LABEL_ZH: Record<AIActionType, string> = {
  HINT: '提示',
  EXPLAIN: '解释',
  CORRECT: '纠错',
  REWRITE: '改写',
  GENERATE: '生成',
  SCORE: '评分',
  TRANSLATE: '翻译',
  OTHER: '其他',
};

export const ADOPTION_STATUSES: AdoptionStatus[] = ['ADOPTED', 'PARTIAL', 'REJECTED'];

export const ADOPTION_STATUS_LABEL_ZH: Record<AdoptionStatus, string> = {
  ADOPTED: '全部采纳',
  PARTIAL: '部分采纳',
  REJECTED: '未采纳',
};

/** Coach 协议顺序：AI 提示必须发生在一次自己的尝试之后。 */
export const COACH_STEPS: CoachStep[] = [
  'ATTEMPT',
  'DIAGNOSE',
  'HINT',
  'PRACTICE',
  'RETEST',
  'EVIDENCE',
];

export const COACH_STEP_LABEL_ZH: Record<CoachStep, string> = {
  ATTEMPT: '1. 先自己尝试',
  DIAGNOSE: '2. 诊断卡点',
  HINT: '3. 提示阶梯',
  PRACTICE: '4. 定向练习',
  RETEST: '5. 复测',
  EVIDENCE: '6. 更新证据',
};

export const COACH_STEP_GUIDE_ZH: Record<CoachStep, string> = {
  ATTEMPT: '不看答案、不用 AI，先完整做一次（30 秒口语、短句写作、1 分钟听写都算），并保存为 A0 证据。',
  DIAGNOSE: '回看自己的产出，指出卡住的那一环（词汇、切分、句法、组织…），在诊断页记录一条障碍。',
  HINT: '按 A1→A2→A3 逐级请求最小提示；一次只要一层，用完先自己重做，再决定是否需要下一层。',
  PRACTICE: '用提示做定向练习，但产出必须由自己写/说；AI 改写只能当参照，不能当作练习结果。',
  RETEST: '换平行材料、撤掉所有支架（A0）复测同一个卡点；复测结果单独保存为证据。',
  EVIDENCE: '把复测样本挂到证据链，更新分项画像与复测计划；仍不达标就回到诊断，换一个更小的目标。',
};

/** 只有 A0 的 AI 使用才可能视为独立产出；A4（代写/代答）永远不算。 */
export const AI_USAGE_NOTE_ZH =
  'AI 输出默认是辅助材料：A4 代写/代答永远不算你的独立产出；「改写/生成」类操作至少要按 A3 记录。';

export const AI_A4_DEPENDENCY_WARN_PERCENT = 30;
export const AI_USAGE_RECENT_DAYS = 30;
export const AI_USAGE_RECENT_LIMIT = 100;

// ───────────────────────── 方法论资料库 ─────────────────────────

export const RESOURCE_PRIORITIES: ResourcePriority[] = ['P0', 'P1', 'P2'];

export const RESOURCE_PRIORITY_LABEL_ZH: Record<ResourcePriority, string> = {
  P0: 'P0 先读',
  P1: 'P1 技能方法',
  P2: 'P2 长期扩展',
};

export const RESOURCE_READ_STATUSES: ResourceReadStatus[] = [
  'NOT_STARTED',
  'READING',
  'SUMMARIZED',
  'APPLIED',
  'DONE',
];

export const RESOURCE_READ_STATUS_LABEL_ZH: Record<ResourceReadStatus, string> = {
  NOT_STARTED: '未开始',
  READING: '阅读中',
  SUMMARIZED: '已写摘要',
  APPLIED: '已实践',
  DONE: '已完成',
};

/** 阅读进度只在真正完成一项实践后标记完成；收藏/打开链接不算掌握。 */
export const RESOURCE_DONE_REQUIRES_ACTION = true;

/** 方法论资料库分类（六类）。 */
export const METHODOLOGY_CATEGORIES: MethodologyCategory[] = [
  '入口',
  '诊断',
  '证据',
  '复盘',
  'AI',
  '工具',
];

export const METHODOLOGY_CATEGORY_LABEL_ZH: Record<MethodologyCategory, string> = {
  入口: '官方入口',
  诊断: '诊断与评分',
  证据: '产出规范',
  复盘: '复盘参考',
  AI: 'AI 与记忆',
  工具: '练习工具',
};

export const METHODOLOGY_CATEGORY_NOTE_ZH: Record<MethodologyCategory, string> = {
  入口: '核对考试事实与流程，不替代练习',
  诊断: '定位技能短板与评分标准',
  证据: '写出口语/写作可检查样本的规范来源',
  复盘: '对照自己的样本复盘，而不是只看范文',
  AI: '辅助记忆与检索，产物仍按辅助级别记录',
  工具: '长期练习与输入输出材料',
};

/** 资料库只允许存元数据、许可说明与个人摘要，不复制正文。 */
export const LIBRARY_NO_COPY_NOTE_ZH =
  '本资料库只保存标题、链接、许可说明、阶段适配与你自己的摘要/实践记录；不复制原文内容，正文版权与访问条件以原站为准。';

/** 阅读状态推进规则（与 domain/library.ts 的 gate 一致）。 */
export const LIBRARY_STATUS_RULE_NOTE_ZH =
  '标记「已写摘要」需至少 20 字个人摘要；「已实践」需写明实际做了什么；「已完成」需填写实践计划——收藏或打开链接不算掌握。';

export const LIBRARY_SUMMARY_MIN_CHARS = 20;

/** 预设资料条数（seed 必须恰好 16 条）。 */
export const LIBRARY_SEED_SIZE = 16;

/** ResourceReference 的资源类型（v2.2 方法论资料库）。 */
export type LibraryResourceType = 'REPO' | 'ARTICLE' | 'TEMPLATE' | 'GUIDE';

export const LIBRARY_RESOURCE_TYPE_LABEL_ZH: Record<LibraryResourceType, string> = {
  REPO: '开源仓库',
  ARTICLE: '文章 / 频道',
  TEMPLATE: '模板 / 范式',
  GUIDE: '指南 / 课程',
};

// ───────────────────────── 证据与预算的融合 ─────────────────────────

/** ≤15 分钟只要求微型证据；≥180 分钟才展开完整证据链。 */
export const EVIDENCE_NO_CHAIN_BUDGET_MAX = 15;
export const EVIDENCE_STANDARD_BUDGET_MIN = 60;
export const EVIDENCE_FULL_CHAIN_BUDGET_MIN = 180;

/** 预算档 → 建议的证据级别（计划引擎与页面提示共用，覆盖全部非负分钟）。 */
export const BUDGET_EVIDENCE_LEVEL_HINT_ZH: Array<{
  minMinutes: number;
  maxMinutes: number | null;
  level: EvidenceLevel | null;
  advice: string;
}> = [
  {
    minMinutes: 0,
    maxMinutes: EVIDENCE_NO_CHAIN_BUDGET_MAX,
    level: null,
    advice: '应急维护：不要求完整证据链，到期知识复习或一个微型听/读任务，记录一个结果即可。',
  },
  {
    minMinutes: EVIDENCE_NO_CHAIN_BUDGET_MAX + 1,
    maxMinutes: EVIDENCE_STANDARD_BUDGET_MIN - 1,
    level: 'QUICK',
    advice: 'Quick Evidence：记录主技能、材料、实际时长、一个产出和一个主要障碍。',
  },
  {
    minMinutes: EVIDENCE_STANDARD_BUDGET_MIN,
    maxMinutes: EVIDENCE_FULL_CHAIN_BUDGET_MIN - 1,
    level: 'STANDARD',
    advice: 'Quick + Standard：对重点任务保存首版/反馈/即时复测中的必要部分。',
  },
  {
    minMinutes: EVIDENCE_FULL_CHAIN_BUDGET_MIN,
    maxMinutes: null,
    level: 'FULL',
    advice: '可开展 Full Evidence Chain：完整诊断、定向修复、作品修订和独立复测。',
  },
];

// ───────────────────────── 分项画像 ─────────────────────────

/** 各置信度的建议复评间隔（天）：低 14 / 中 30 / 高 90。 */
export const PROFILE_REVIEW_DAYS: Record<EvidenceConfidence, number> = {
  LOW: 14,
  MEDIUM: 30,
  HIGH: 90,
};

/** 画像页固定提示：四项分开展示，不取平均。 */
export const PROFILE_NO_AVERAGE_NOTE =
  '四项技能分别判断；系统不计算四项平均等级，也不把内部证据分换算成 CEFR 或 IELTS Band。';

export const PROFILE_DO_NOT_INFER_PRESET =
  '本判断只基于已保存的证据样本与条件；不能说明未测试的主题、真实交流压力下的表现或官方考试分数。';
