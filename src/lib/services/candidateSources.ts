/**
 * 候选采集（T03）：把 8 个来源的库行归一成 `TaskCandidateDraft`。
 *
 * 本文件是 `collectCandidates()` 的**唯一实现处**，也是全站唯一同时碰这 12 张表的
 * 地方。四个容易反复踩的坑，先写在前面：
 *
 * 1. **本层不做预算/优先级过滤**。采集只看「行是否满足入池条件」（到期、未排过、
 *    材料已就绪、题已批准…）。「今天放不放得下」「该不该排」是装箱层与评分层的事。
 *    一旦这里开始按 `budgetMinutes` 裁剪，同一天的两个预算档会得到**不同的候选池**，
 *    于是「为什么换了个预算候选就没了」变成无法解释的事。
 * 2. **日期一律从 `input.asOfDate` 来**。本模块不调用 `new Date()` / `today()` ——
 *    否则同一快照在不同时刻执行会得到不同池子，而 `inputHash` 只对入参负责，
 *    它不会因为"今天是几号变了"而改变。测试也就无法固定时间。
 * 3. **时长必须诚实标注**：源表**本来就没有**时长字段的（`PROBE`/`QUESTION`/`LAB`）
 *    走 `CANDIDATE_DEFAULT_MINUTES` 并标 `DERIVED`；源表**本该有却为空**的
 *    （`REVIEW`/`RETEST`/`VOCAB`/`MATERIAL`/`EGIU`）走 `CANDIDATE_FALLBACK_MINUTES`
 *    并标 `derivedFrom: 'fallback:…'` —— 后者是**数据问题**，必须在一堆候选里看得见。
 * 4. **未知枚举值不许静默造数**：库里出现表外的 `taskType` / `mode` / `skill` 时，
 *    该行**不入池**并写进 `skipped`。给它编一个默认分钟数会变成"一条永远排在错的
 *    位置的任务"，而没人能从结果里看出它是脏数据。
 */

import {
  CANDIDATE_DEFAULT_MINUTES,
  CANDIDATE_FALLBACK_MINUTES,
  EST_MINUTES_BY_INTERVAL,
  INTERVAL_CODES,
  LISTENING_MODES,
  MATERIAL_EXERCISE_TYPES,
  MIN_TASK_MINUTES,
  MODULE_TRACK,
  QUESTION_OPEN_TASK_SKILL_OVERRIDE,
  SKILL_LABEL_ZH,
  SKILL_TO_PRIMARY,
  SPEAKING_TASK_TYPES,
  TARGET_TYPE_LABEL_ZH,
  type ListeningMode,
  type MaterialExerciseType,
  type MinuteBearingSourceKind,
  type SpeakingTaskType,
} from '@/lib/constants';
import {
  DIAGNOSTIC_AUX_SKILLS,
  DIAG_TASK_TYPES,
  type DiagnosticSkill,
  type DiagTaskType,
} from '@/lib/diagnostic/constants';
import {
  candidateKeyOf,
  gapKeyOf,
  sourceRefOf,
  type CandidateSourceKind,
  type Prerequisite,
  type TaskCandidateDraft,
} from '@/lib/domain/taskCandidate';
import { prisma } from '@/lib/prisma';
import type { IntervalCode, ModuleId, SkillId, TargetType } from '@/lib/types';

// ───────────────────────── 采集入参与出参 ─────────────────────────

/**
 * 采集层看到的缺口。
 *
 * **必须由调用方从快照/DTO 传入，本模块不查 `SkillGap` 表**（`42` T04 ⑭b / C-H）：
 * `SkillGap` 表里没有 `evidenceQuestions` / `repeatedErrorCount` 列，从表里查出来的
 * 缺口天生缺这两个字段，评分层的 `errorRecurrence` 会恒为 0 而不报错。
 */
export interface CandidateGap {
  /** OFFICIAL | AUXILIARY */
  dimensionKind: string;
  skill: string;
  /** 空串 = 技能级缺口 */
  subskill: string;
  /** GAP | UNCERTAINTY | UNKNOWN */
  kind: string;
}

export interface CollectCandidatesInput {
  /** 业务日期（`YYYY-MM-DD`）。本模块**唯一**的时间来源。 */
  asOfDate: string;
  /** 缺口（缺省空数组）。只有 `kind='UNCERTAINTY'` 会产出 `PROBE`。 */
  gaps?: readonly CandidateGap[];
}

/** 一条没能入池的源行及原因（UI 空态与审计都用它）。 */
export interface SkippedCandidate {
  sourceKind: CandidateSourceKind;
  sourceRef: string | null;
  why: string;
}

export interface CollectCandidatesResult {
  candidates: TaskCandidateDraft[];
  skipped: SkippedCandidate[];
  /** 采集过程中抛错的来源（空数组 = 8 源全部跑过）。 */
  degraded: CandidateSourceKind[];
}

/** 采集层向外报告"这行为什么没进池"的通道。 */
export type SkipSink = (skip: SkippedCandidate) => void;

const NOOP_SINK: SkipSink = () => {};

// ───────────────────────── 时长派生（唯一实现处） ─────────────────────────

/** 派生分钟 + 出处。`derivedFrom` 必须能直接进解释面板。 */
export interface DerivedMinutes {
  estMinutes: number;
  derivedFrom: string;
}

function isDiagTaskType(value: string): value is DiagTaskType {
  return (DIAG_TASK_TYPES as readonly string[]).includes(value);
}

function isMaterialExerciseType(value: string): value is MaterialExerciseType {
  return (MATERIAL_EXERCISE_TYPES as readonly string[]).includes(value);
}

function isListeningMode(value: string): value is ListeningMode {
  return (LISTENING_MODES as readonly string[]).includes(value);
}

function isSpeakingTaskType(value: string): value is SpeakingTaskType {
  return (SPEAKING_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * 派生分钟的**查找点**（`PROBE` / `QUESTION` / `LAB` 三类来源）。
 *
 * 为什么必须收敛到这一个函数：`Partial` 表（`QUESTION_OPEN_TASK_SKILL_OVERRIDE`）
 * 的安全性全在**调用处有没有写 `??`** —— 表本身可以完全合法，而 8 个采集函数各自
 * 写一遍 `OVERRIDE[skill] ?? 15`，漏一个就是 `undefined` 流进 `Σ minutes`。
 * 单点之后，`candidateSources.test.ts` 才能在这里断言「缺失侧每一条都得到 15」。
 *
 * @param spec `{ taskType, skill }` → QUESTION；`{ mode }` → LAB；`{ probe: true }` → PROBE
 */
export function estMinutesOf(spec: { taskType: string; skill: SkillId }): DerivedMinutes;
export function estMinutesOf(spec: { mode: string }): DerivedMinutes;
export function estMinutesOf(spec: { probe: true }): DerivedMinutes;
export function estMinutesOf(spec: {
  taskType?: string;
  skill?: SkillId;
  mode?: string;
  probe?: true;
}): DerivedMinutes {
  if (typeof spec.taskType === 'string') {
    const { taskType, skill } = spec;
    if (taskType === 'OPEN_TASK' && skill) {
      // 覆写**只对 OPEN_TASK 生效**：其余题型在 skill 之间没有量级差异，
      // 一旦泛化就会变成「MCQ=3 与 OVERRIDE[WRITING]=8 同时存在，谁生效看 if 顺序」。
      const override = QUESTION_OPEN_TASK_SKILL_OVERRIDE[skill];
      if (typeof override === 'number') {
        return { estMinutes: override, derivedFrom: `skillOverride:OPEN_TASK/${skill}` };
      }
      return { estMinutes: CANDIDATE_DEFAULT_MINUTES.QUESTION.OPEN_TASK, derivedFrom: 'default:OPEN_TASK' };
    }
    if (isDiagTaskType(taskType) || isMaterialExerciseType(taskType)) {
      return {
        estMinutes: CANDIDATE_DEFAULT_MINUTES.QUESTION[taskType],
        derivedFrom: `CANDIDATE_DEFAULT_MINUTES.QUESTION.${taskType}`,
      };
    }
    // 表外题型：不猜。`Infinity` 会让装箱层"看起来放得下"，`0` 会让它"看起来免费"。
    throw new UnknownMinuteKeyError(`QUESTION 的题型 ${taskType} 不在 CANDIDATE_DEFAULT_MINUTES.QUESTION 内`);
  }
  if (typeof spec.mode === 'string') {
    const { mode } = spec;
    if (isListeningMode(mode) || isSpeakingTaskType(mode)) {
      return {
        estMinutes: CANDIDATE_DEFAULT_MINUTES.LAB[mode],
        derivedFrom: `CANDIDATE_DEFAULT_MINUTES.LAB.${mode}`,
      };
    }
    throw new UnknownMinuteKeyError(`LAB 的 mode ${mode} 不在 CANDIDATE_DEFAULT_MINUTES.LAB 内`);
  }
  return {
    estMinutes: CANDIDATE_DEFAULT_MINUTES.PROBE,
    derivedFrom: 'CANDIDATE_DEFAULT_MINUTES.PROBE',
  };
}

/** 表外键：采集层用 `isAxesSkill` 之类的守卫预先拦掉，走到这里说明守卫漏了。 */
export class UnknownMinuteKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownMinuteKeyError';
  }
}

/**
 * `EGIU` 两级取值：先按 `intervalCode` 查既有常量（更准），未知才落兜底。
 *
 * 两级**都**标 `DERIVED`：`EST_MINUTES_BY_INTERVAL` 是按间隔档的估计，不是这一行
 * 的真实耗时；`fallback:` 前缀则直接宣告"这条的间隔档我们不知道"，让它在一堆
 * 候选里显形。
 */
export function egiuMinutesOf(intervalCode: string | null): DerivedMinutes {
  if (typeof intervalCode === 'string' && (INTERVAL_CODES as readonly string[]).includes(intervalCode)) {
    return {
      estMinutes: EST_MINUTES_BY_INTERVAL[intervalCode as IntervalCode],
      derivedFrom: `EST_MINUTES_BY_INTERVAL.${intervalCode}`,
    };
  }
  return {
    estMinutes: CANDIDATE_FALLBACK_MINUTES.EGIU,
    derivedFrom: 'fallback:EGIU(unknown interval)',
  };
}

/**
 * 源表**有**时长字段时的取值：非正数/非有限数一律视为"本该有却没有"。
 *
 * 为什么把 `0` 也算缺失：`VocabularyAssignment.estimatedMinutes` 的默认值就是 `0`，
 * 而 0 分钟的任务在装箱时**永远放得下**，会挤掉真实任务且不留痕迹。
 */
export function sourceMinutesOf(
  kind: MinuteBearingSourceKind,
  raw: number | null | undefined,
): { estMinutes: number; meta: TaskCandidateDraft['meta'] } {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { estMinutes: raw, meta: { estMinutesSource: 'SOURCE' } };
  }
  return {
    estMinutes: CANDIDATE_FALLBACK_MINUTES[kind],
    meta: { estMinutesSource: 'DERIVED', derivedFrom: `fallback:${kind}(${raw ?? 'null'})` },
  };
}

// ───────────────────────── 轴映射（module / targetSkill） ─────────────────────────

interface Axes {
  module: ModuleId;
  skill: SkillId;
}

/**
 * 技能 → `(module, targetSkill)`。
 *
 * 键集是 `DiagnosticSkill` 全 8 值，因此它同时覆盖三处使用：
 * - `SkillGap.skill`（OFFICIAL 四项 + AUXILIARY 三项，是它的子集）；
 * - `DiagnosticItem.skill`（全 8 值，含 `EMLR`）；
 * - `GeneratedExercise.targetSkill`（`READING|VOCABULARY|GRAMMAR`，子集）。
 *
 * 合成一张表而不是三张：三张表会把「同一技能在缺口域叫 VOCABULARY、在计划域叫
 * VOCAB_REVIEW」这件事描述三遍，而三遍描述迟早不一致。
 */
const AXES_BY_SKILL: Record<DiagnosticSkill, Axes> = {
  LISTENING: { module: 'LISTENING', skill: 'LISTENING' },
  READING: { module: 'READING', skill: 'READING' },
  SPEAKING: { module: 'SPEAKING', skill: 'SPEAKING' },
  WRITING: { module: 'WRITING', skill: 'WRITING' },
  GRAMMAR: { module: 'GRAMMAR', skill: 'GRAMMAR' },
  VOCABULARY: { module: 'VOCAB_REVIEW', skill: 'VOCAB' },
  SENTENCE_STRUCTURE: { module: 'SENTENCE', skill: 'SENTENCE' },
  EMLR: { module: 'MEDIATED', skill: 'MEDIATED' },
};

/**
 * `ReviewTask.targetType` → 轴。
 *
 * ⚠️ `MISTAKE` 刻意落到 `P0_REVIEW` / `META`：`Mistake` 表**没有 skill 列**
 * （只有 `knowledgePoint` / `errorCategory`），所以"这条错题复习属于哪一科"
 * 在行上根本读不到。硬猜一个技能会让「阅读错题」被记成写作训练时间；
 * 而 `P0_REVIEW` 正是 v2.1 用来装"到期复习执行"的模块，`META` 不进四技能分母 ——
 * 不猜，但也不丢。
 */
const AXES_BY_TARGET_TYPE: Record<TargetType, Axes> = {
  EGIU_LESSON: AXES_BY_SKILL.GRAMMAR,
  GRAMMAR_POINT: AXES_BY_SKILL.GRAMMAR,
  VOCAB_WORD: AXES_BY_SKILL.VOCABULARY,
  MISTAKE: { module: 'P0_REVIEW', skill: 'META' },
};

function isTargetType(value: string): value is TargetType {
  return Object.prototype.hasOwnProperty.call(AXES_BY_TARGET_TYPE, value);
}

function isAxesSkill(value: string): value is DiagnosticSkill {
  return Object.prototype.hasOwnProperty.call(AXES_BY_SKILL, value);
}

/** 缺口键：`OFFICIAL` 四项之外一律 `AUXILIARY`（决定它进不进四技能分母）。 */
function dimensionKindOf(skill: string): 'OFFICIAL' | 'AUXILIARY' {
  return (DIAGNOSTIC_AUX_SKILLS as readonly string[]).includes(skill) ? 'AUXILIARY' : 'OFFICIAL';
}

// ───────────────────────── DTO 装配 ─────────────────────────

interface DraftInit {
  sourceKind: CandidateSourceKind;
  sourceRef: string | null;
  axes: Axes;
  skillGapKey?: string | null;
  title: string;
  estMinutes: number;
  minMinutes: number;
  maxBlockMinutes?: number | null;
  prerequisites?: Prerequisite[];
  validationStatus: TaskCandidateDraft['validationStatus'];
  difficultyScore?: number | null;
  expectedOutput?: string | null;
  meta: TaskCandidateDraft['meta'];
}

/**
 * 由"8 源共有的部分"装配一条候选。
 *
 * `candidateKey` 一律经 `candidateKeyOf()` 生成 —— 8 个采集函数各拼一次字符串，
 * 迟早出现 `REVIEW:id:module` 与 `review:id:module` 并存，而身份分叉的后果是
 * 跨快照比对与去重**同时**静默失效。
 */
function makeDraft(init: DraftInit): TaskCandidateDraft {
  const base = { sourceKind: init.sourceKind, sourceRef: init.sourceRef, module: init.axes.module };
  return {
    candidateKey: candidateKeyOf(base),
    sourceKind: init.sourceKind,
    sourceRef: init.sourceRef,
    module: init.axes.module,
    targetSkill: init.axes.skill,
    primarySkill: SKILL_TO_PRIMARY[init.axes.skill],
    track: MODULE_TRACK[init.axes.module],
    skillGapKey: init.skillGapKey ?? null,
    title: init.title,
    estMinutes: init.estMinutes,
    minMinutes: init.minMinutes,
    maxBlockMinutes: init.maxBlockMinutes ?? null,
    prerequisites: init.prerequisites ?? [],
    validationStatus: init.validationStatus,
    difficultyScore: init.difficultyScore ?? null,
    // **初始恒 false**：只有 AI 层可以置 true（UI 必须能区分"系统派的"与"AI 建议的"）
    isAiSuggested: false,
    aiCallLogId: null,
    expectedOutput: init.expectedOutput ?? null,
    meta: init.meta,
  };
}

function truncate(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ───────────────────────── 1. REVIEW ─────────────────────────

/** 知识型复习（`ReviewTask` 到期）。 */
export async function collectReviewCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const rows = await prisma.reviewTask.findMany({
    where: { status: 'PENDING', dueDate: { lte: input.asOfDate } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  });
  const out: TaskCandidateDraft[] = [];
  for (const row of rows) {
    const sourceRef = sourceRefOf('REVIEW', row.id);
    if (!isTargetType(row.targetType)) {
      sink({ sourceKind: 'REVIEW', sourceRef, why: `未知的复习目标类型 ${row.targetType}，无法确定模块` });
      continue;
    }
    // `ReviewTask` 没有 skill/subskill 列 —— 绝大多数复习项的缺口键天生为空，
    // 于是它们的 `dedupeGroup` 回落 `candidateKey`，各走各的（不许合并成一条）。
    const minutes = sourceMinutesOf('REVIEW', row.estMinutes);
    out.push(
      makeDraft({
        sourceKind: 'REVIEW',
        sourceRef,
        axes: AXES_BY_TARGET_TYPE[row.targetType],
        title: `${TARGET_TYPE_LABEL_ZH[row.targetType]}复习：${row.targetLabel}`,
        estMinutes: minutes.estMinutes,
        // 复习项是**原子**的：做半条复习等于没复习，不可拆
        minMinutes: minutes.estMinutes,
        validationStatus: 'VERIFIED',
        meta: minutes.meta,
      }),
    );
  }
  return out;
}

// ───────────────────────── 2. RETEST ─────────────────────────

/** 技能型证据复测（`RetestSchedule` 到期且未落计划）。 */
export async function collectRetestCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const rows = await prisma.retestSchedule.findMany({
    where: { status: 'PENDING', dueDate: { lte: input.asOfDate }, planTaskId: null },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    include: { parent: { select: { id: true, skill: true } } },
  });
  const out: TaskCandidateDraft[] = [];
  for (const row of rows) {
    const sourceRef = sourceRefOf('RETEST', row.id);
    const skill = row.parent?.skill ?? '';
    if (!isAxesSkill(skill)) {
      sink({ sourceKind: 'RETEST', sourceRef, why: `父证据 ${row.parentEvidenceId} 的技能 ${skill} 无法映射到模块` });
      continue;
    }
    const minutes = sourceMinutesOf('RETEST', row.estMinutes);
    out.push(
      makeDraft({
        sourceKind: 'RETEST',
        sourceRef,
        axes: AXES_BY_SKILL[skill],
        // `EvidenceRecord` 没有 subskill 列 → 技能级缺口（空串是**显式**表达，不是缺省）
        skillGapKey: gapKeyOf(dimensionKindOf(skill), skill, ''),
        title: `${SKILL_LABEL_ZH[AXES_BY_SKILL[skill].skill]}复测：${row.retestType}`,
        estMinutes: minutes.estMinutes,
        // v2.1 语义：复测不可拆 —— 做半截的复测无法判定是否迁移
        minMinutes: minutes.estMinutes,
        prerequisites: [{ kind: 'EVIDENCE_EXISTS', evidenceId: row.parentEvidenceId }],
        validationStatus: 'VERIFIED',
        meta: minutes.meta,
      }),
    );
  }
  return out;
}

// ───────────────────────── 3. PROBE ─────────────────────────

/**
 * 补测：由 `SkillGap(kind='UNCERTAINTY')` 驱动的"证据不足、先测一下"。
 *
 * `sourceKind` 在候选 DTO 里是 `PROBE`（`candidateKey` 前缀 `probe`），
 * 落 `PlanTask` 时才映射成 `RETEST`（徽章文案是「补测」而不是「弱项强化」，
 * 见 `41 §2.5.1`）—— 这里保持 `PROBE`，不要在采集层提前映射。
 */
export async function collectProbeCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const gaps = (input.gaps ?? []).filter((gap) => gap.kind === 'UNCERTAINTY');
  if (gaps.length === 0) return [];

  const items = await prisma.diagnosticItem.findMany({
    where: { active: true, validationStatus: 'VERIFIED' },
    select: { id: true, skill: true, subskill: true },
  });
  // 一次查回、内存里建索引：按缺口逐条查会变成 N+1，而缺口最多几十个
  const itemIdsByKey = new Map<string, string[]>();
  for (const item of items) {
    const key = `${item.skill}|${item.subskill}`;
    const bucket = itemIdsByKey.get(key) ?? [];
    bucket.push(item.id);
    itemIdsByKey.set(key, bucket);
  }

  const out: TaskCandidateDraft[] = [];
  for (const gap of gaps) {
    const sourceRef = sourceRefOf('PROBE', gap.skill, gap.subskill);
    if (!isAxesSkill(gap.skill)) {
      sink({ sourceKind: 'PROBE', sourceRef, why: `缺口技能 ${gap.skill} 无法映射到模块` });
      continue;
    }
    const matched = itemIdsByKey.get(`${gap.skill}|${gap.subskill}`) ?? [];
    const firstItem = matched[0];
    if (!firstItem) {
      sink({ sourceKind: 'PROBE', sourceRef, why: `缺口 ${gap.skill}/${gap.subskill} 没有对应的已验证诊断题` });
      continue;
    }
    const minutes = estMinutesOf({ probe: true });
    out.push(
      makeDraft({
        sourceKind: 'PROBE',
        sourceRef,
        axes: AXES_BY_SKILL[gap.skill],
        skillGapKey: gapKeyOf(gap.dimensionKind || dimensionKindOf(gap.skill), gap.skill, gap.subskill),
        title: `补测：${SKILL_LABEL_ZH[AXES_BY_SKILL[gap.skill].skill]}${gap.subskill ? ` · ${gap.subskill}` : ''}`,
        estMinutes: minutes.estMinutes,
        minMinutes: minutes.estMinutes,
        validationStatus: 'VERIFIED',
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }
  return out;
}

// ───────────────────────── 4. VOCAB ─────────────────────────

/** 词汇任务（`VocabularyAssignment` 当日且未落计划）。 */
export async function collectVocabCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  // 刻意**不**在 `where` 里写 `planTaskId: null`：`@@unique([assignmentDate])` 保证
  // 一个日期最多一行，多取一行不花钱，而这样"已排过"才有分支可写、才能报出原因。
  const rows = await prisma.vocabularyAssignment.findMany({
    where: { assignmentDate: input.asOfDate, status: 'PLANNED' },
    orderBy: [{ assignmentDate: 'asc' }, { id: 'asc' }],
  });
  const out: TaskCandidateDraft[] = [];
  for (const row of rows) {
    const sourceRef = sourceRefOf('VOCAB', row.id);
    if (row.planTaskId) {
      sink({ sourceKind: 'VOCAB', sourceRef, why: 'already-planned：该词汇任务已落成计划任务' });
      continue;
    }
    const minutes = sourceMinutesOf('VOCAB', row.estimatedMinutes);
    out.push(
      makeDraft({
        sourceKind: 'VOCAB',
        sourceRef,
        axes: AXES_BY_SKILL.VOCABULARY,
        title: `词汇任务：复习 ${row.reviewTarget} + 新词 ${row.newTarget}`,
        estMinutes: minutes.estMinutes,
        // 词汇可以只做一部分（新词/复习分开），所以最小单元是全局粒度而不是整包
        minMinutes: MIN_TASK_MINUTES,
        validationStatus: 'VERIFIED',
        meta: minutes.meta,
      }),
    );
  }
  return out;
}

// ───────────────────────── 5. MATERIAL ─────────────────────────

/**
 * 材料：`MaterialPackItem` → `TaskProposalItem`。
 *
 * 两段式的理由：**包里有的条目不一定被提案**（材料刚解析完、AI 还没生成草案，
 * 或者草案被 `discard`），而**提案了不一定没排过**。这两种情况对用户是两件事：
 * 前者叫"这条材料还没排进计划"，后者叫"已经排过了"。合成一句「无候选」，
 * 用户就只能猜。
 */
export async function collectMaterialCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const packItems = await prisma.materialPackItem.findMany({
    where: { pack: { material: { status: { in: ['ready', 'partial'] } } } },
    select: { id: true, pack: { select: { id: true } } },
  });
  const proposals = await prisma.taskProposalItem.findMany({
    where: { proposal: { status: 'draft' } },
    orderBy: [{ proposalId: 'asc' }, { id: 'asc' }],
    include: { proposal: { select: { packId: true, materialId: true } } },
  });
  const proposalPacks = new Set(proposals.map((row) => row.proposal.packId).filter((id): id is string => !!id));

  for (const packItem of packItems) {
    if (!proposalPacks.has(packItem.pack.id)) {
      sink({ sourceKind: 'MATERIAL', sourceRef: null, why: 'no-proposal：该材料条目还没有草案（或被丢弃）' });
    }
  }

  const exerciseIds = proposals.flatMap(parseExerciseIds);
  const approvedIds = new Set(
    exerciseIds.length === 0
      ? []
      : (
          await prisma.generatedExercise.findMany({
            where: { id: { in: exerciseIds }, reviewStatus: 'approved' },
            select: { id: true },
          })
        ).map((row) => row.id),
  );

  const out: TaskCandidateDraft[] = [];
  for (const row of proposals) {
    const sourceRef = sourceRefOf('MATERIAL', row.id);
    if (row.planTaskId) {
      sink({ sourceKind: 'MATERIAL', sourceRef, why: 'already-planned：该草案条目已落成计划任务' });
      continue;
    }
    const axes = materialAxesOf(row.module, row.targetSkill);
    if (!axes) {
      sink({ sourceKind: 'MATERIAL', sourceRef, why: `草案条目的 module=${row.module} / targetSkill=${row.targetSkill} 无法映射` });
      continue;
    }
    const ids = parseExerciseIds(row);
    const prerequisites: Prerequisite[] = [
      { kind: 'MATERIAL_READY', materialId: row.proposal.materialId },
      ...ids.map((exerciseId) => ({ kind: 'EXERCISE_APPROVED' as const, exerciseId })),
    ];
    const minutes = sourceMinutesOf('MATERIAL', row.finalMinutes ?? row.suggestedMinutes);
    const granularity = row.granularity > 0 ? row.granularity : MIN_TASK_MINUTES;
    out.push(
      makeDraft({
        sourceKind: 'MATERIAL',
        sourceRef,
        axes,
        title: row.title,
        estMinutes: minutes.estMinutes,
        minMinutes: granularity,
        maxBlockMinutes: granularity,
        prerequisites,
        validationStatus: ids.some((id) => approvedIds.has(id)) ? 'VERIFIED' : 'UNVERIFIED',
        meta: minutes.meta,
      }),
    );
  }
  return out;
}

/** `TaskProposalItem.exerciseIdsJson` → 数组（脏值一律当空，不抛）。 */
function parseExerciseIds(row: { exerciseIdsJson: string | null }): string[] {
  if (!row.exerciseIdsJson) return [];
  try {
    const parsed: unknown = JSON.parse(row.exerciseIdsJson);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 草案条目的 `(module, targetSkill)`：两个字段都由 v2.6 写入，仍需按表校验。 */
function materialAxesOf(module: string, targetSkill: string): Axes | null {
  if (!Object.prototype.hasOwnProperty.call(MODULE_TRACK, module)) return null;
  if (!isAxesSkill(targetSkill)) return null;
  return { module: module as ModuleId, skill: AXES_BY_SKILL[targetSkill].skill };
}

// ───────────────────────── 6. QUESTION ─────────────────────────

/**
 * 题库（诊断题 + 材料题）两条链路。
 *
 * ⚠️ 规格（`41 §2.3.2`）给 QUESTION 的前置条件写的是 `{STAGE_AT_LEAST}`，但全仓
 * **没有**「技能 → 最低阶段」的真值表（`STAGE_META` 只有 `allowedEgiu`）。凭空补一张
 * 表会在 S0/S1 静默挡掉全部题库候选，而那种"候选池突然空了"没人能归因。所以这里
 * 前置条件留空，并登记到 `docs/47-known-limits.md`。
 */
export async function collectQuestionCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const items = await prisma.diagnosticItem.findMany({
    where: { active: true, validationStatus: 'VERIFIED' },
    orderBy: [{ skill: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
  const exercises = await prisma.generatedExercise.findMany({
    where: { reviewStatus: 'approved', retiredAt: null },
    orderBy: [{ type: 'asc' }, { id: 'asc' }],
  });

  const out: TaskCandidateDraft[] = [];
  for (const item of items) {
    const sourceRef = sourceRefOf('QUESTION', item.id, 'diagnostic');
    if (!isAxesSkill(item.skill)) {
      sink({ sourceKind: 'QUESTION', sourceRef, why: `诊断题技能 ${item.skill} 无法映射到模块` });
      continue;
    }
    const minutes = collectQuestionMinutes(item.taskType, AXES_BY_SKILL[item.skill].skill, sourceRef, sink);
    if (!minutes) continue;
    const difficulty = Number.isFinite(item.difficulty) ? Math.min(1, Math.max(0, (item.difficulty - 1) / 3)) : null;
    out.push(
      makeDraft({
        sourceKind: 'QUESTION',
        sourceRef,
        axes: AXES_BY_SKILL[item.skill],
        title: `诊断题：${truncate(item.prompt)}`,
        estMinutes: minutes.estMinutes,
        // `minMinutes = estMinutes`：开放题走 skill 覆写后最小可执行单元随之变大，
        // 大作文**不该**再被塞进 15 分钟的应急日
        minMinutes: minutes.estMinutes,
        validationStatus: item.sourceType === 'RUBRIC' ? 'RUBRIC' : 'VERIFIED',
        difficultyScore: difficulty,
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }

  for (const exercise of exercises) {
    const sourceRef = sourceRefOf('QUESTION', exercise.id, 'material_exercise');
    if (!isAxesSkill(exercise.targetSkill)) {
      sink({ sourceKind: 'QUESTION', sourceRef, why: `材料题技能 ${exercise.targetSkill} 无法映射到模块` });
      continue;
    }
    const minutes = collectQuestionMinutes(exercise.type, AXES_BY_SKILL[exercise.targetSkill].skill, sourceRef, sink);
    if (!minutes) continue;
    out.push(
      makeDraft({
        sourceKind: 'QUESTION',
        sourceRef,
        axes: AXES_BY_SKILL[exercise.targetSkill],
        title: `材料题：${truncate(exercise.prompt)}`,
        estMinutes: minutes.estMinutes,
        minMinutes: minutes.estMinutes,
        validationStatus: 'VERIFIED',
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }
  return out;
}

/** 表外题型在这里被拦下并记一条 skip（**不**用默认值兜）。 */
function collectQuestionMinutes(
  taskType: string,
  skill: SkillId,
  sourceRef: string,
  sink: SkipSink,
): DerivedMinutes | null {
  try {
    return estMinutesOf({ taskType, skill });
  } catch (error) {
    sink({
      sourceKind: 'QUESTION',
      sourceRef,
      why: error instanceof UnknownMinuteKeyError ? error.message : '分钟派生失败',
    });
    return null;
  }
}

// ───────────────────────── 7. LAB ─────────────────────────

/**
 * 听说 Lab：`ListeningExercise`（需 `CONFIRMED` 转写）+ `SpeakingPrompt`。
 *
 * `SpeakingPrompt` 没有 `active` 列（`41 §2.3.2` 写的"新增默认 true"在 Phase A 未落地），
 * 因此不过滤 —— 全部入池。这条差异登记在 `docs/47-known-limits.md`。
 */
export async function collectLabCandidates(
  input: CollectCandidatesInput,
  sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const listening = await prisma.listeningExercise.findMany({
    orderBy: [{ mode: 'asc' }, { id: 'asc' }],
    include: { audioAsset: { select: { id: true, title: true } } },
  });
  const confirmed = new Set(
    listening.length === 0
      ? []
      : (
          await prisma.transcript.findMany({
            where: { audioAssetId: { in: listening.map((row) => row.audioAssetId) }, status: 'CONFIRMED' },
            select: { audioAssetId: true },
          })
        ).flatMap((row) => (row.audioAssetId ? [row.audioAssetId] : [])),
  );

  const out: TaskCandidateDraft[] = [];
  for (const row of listening) {
    const sourceRef = sourceRefOf('LAB', row.id, 'listening');
    if (!confirmed.has(row.audioAssetId)) {
      sink({ sourceKind: 'LAB', sourceRef, why: 'no-confirmed-transcript：音频尚无已确认转写' });
      continue;
    }
    const minutes = collectLabMinutes(row.mode, sourceRef, sink);
    if (!minutes) continue;
    out.push(
      makeDraft({
        sourceKind: 'LAB',
        sourceRef,
        axes: AXES_BY_SKILL.LISTENING,
        title: `听力：${row.title}`,
        estMinutes: minutes.estMinutes,
        minMinutes: minutes.estMinutes,
        prerequisites: [{ kind: 'TRANSCRIPT_CONFIRMED', audioAssetId: row.audioAssetId }],
        validationStatus: 'UNVERIFIED',
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }

  const prompts = await prisma.speakingPrompt.findMany({ orderBy: [{ taskType: 'asc' }, { id: 'asc' }] });
  for (const row of prompts) {
    const sourceRef = sourceRefOf('LAB', row.id, 'speaking');
    const minutes = collectLabMinutes(row.taskType, sourceRef, sink);
    if (!minutes) continue;
    out.push(
      makeDraft({
        sourceKind: 'LAB',
        sourceRef,
        axes: AXES_BY_SKILL.SPEAKING,
        title: `口语：${row.title}`,
        estMinutes: minutes.estMinutes,
        minMinutes: minutes.estMinutes,
        validationStatus: 'UNVERIFIED',
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }
  return out;
}

function collectLabMinutes(mode: string, sourceRef: string, sink: SkipSink): DerivedMinutes | null {
  try {
    return estMinutesOf({ mode });
  } catch (error) {
    sink({
      sourceKind: 'LAB',
      sourceRef,
      why: error instanceof UnknownMinuteKeyError ? error.message : '分钟派生失败',
    });
    return null;
  }
}

// ───────────────────────── 8. EGIU ─────────────────────────

/**
 * SOP 教材单元（`EgiuLesson` 到期且非绿灯）。
 *
 * `EgiuLesson` 表**没有** `intervalCode` 列 —— 间隔档在它对应的 `ReviewTask`
 * （`targetType='EGIU_LESSON'`, `targetId=lesson.id`）上。所以这里批量取一次
 * pending 复习点的 `intervalCode`，取最早到期的那条，再走两级取值。
 */
export async function collectEgiuCandidates(
  input: CollectCandidatesInput,
  // 本来源当前没有"行存在但不可入池"的分支（过滤全在 `where` 上），签名保持一致即可
  _sink: SkipSink = NOOP_SINK,
): Promise<TaskCandidateDraft[]> {
  const lessons = await prisma.egiuLesson.findMany({
    where: {
      archivedAt: null,
      currentColor: { not: 'GREEN' },
      nextReviewDate: { not: null, lte: input.asOfDate },
    },
    orderBy: [{ nextReviewDate: 'asc' }, { id: 'asc' }],
  });
  if (lessons.length === 0) return [];

  const lessonIds = lessons.map((row) => row.id);
  const points = await prisma.reviewTask.findMany({
    where: { targetType: 'EGIU_LESSON', targetId: { in: lessonIds }, status: 'PENDING' },
    select: { targetId: true, intervalCode: true },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  });
  const intervalByLesson = new Map<string, string>();
  for (const point of points) {
    if (!intervalByLesson.has(point.targetId)) intervalByLesson.set(point.targetId, point.intervalCode);
  }
  const requiresByLesson = await previousUnitsOf(lessons);

  const out: TaskCandidateDraft[] = [];
  for (const row of lessons) {
    const sourceRef = sourceRefOf('EGIU', row.id);
    const minutes = egiuMinutesOf(intervalByLesson.get(row.id) ?? null);
    const requiresLessonId = requiresByLesson.get(row.id);
    out.push(
      makeDraft({
        sourceKind: 'EGIU',
        sourceRef,
        axes: AXES_BY_SKILL.GRAMMAR,
        skillGapKey: gapKeyOf('AUXILIARY', 'GRAMMAR', ''),
        title: `EGIU ${row.unitNo}：${row.knowledgePoint}`,
        estMinutes: minutes.estMinutes,
        minMinutes: minutes.estMinutes,
        prerequisites: requiresLessonId
          ? [{ kind: 'UNIT_ORDER', lessonId: row.id, requiresLessonId }]
          : [],
        validationStatus: 'VERIFIED',
        meta: { estMinutesSource: 'DERIVED', derivedFrom: minutes.derivedFrom },
      }),
    );
  }
  return out;
}

/**
 * 同 `resource` 内的前序单元（用于 `UNIT_ORDER` 前置条件）。
 *
 * 只对挂了 `resourceId` 的单元有意义：没挂资源的单元之间没有声明的先后关系，
 * 硬按 `unitNo` 排序会把不相干的两本书串起来。
 */
async function previousUnitsOf(
  lessons: readonly { id: string; resourceId: string | null; unitNo: string }[],
): Promise<Map<string, string>> {
  const resourceIds = [...new Set(lessons.flatMap((row) => (row.resourceId ? [row.resourceId] : [])))];
  if (resourceIds.length === 0) return new Map();
  const siblings = await prisma.egiuLesson.findMany({
    where: { resourceId: { in: resourceIds } },
    select: { id: true, resourceId: true, unitNo: true },
  });
  const byResource = new Map<string, { id: string; unitNo: string }[]>();
  for (const row of siblings) {
    if (!row.resourceId) continue;
    const bucket = byResource.get(row.resourceId) ?? [];
    bucket.push({ id: row.id, unitNo: row.unitNo });
    byResource.set(row.resourceId, bucket);
  }
  const result = new Map<string, string>();
  for (const bucket of byResource.values()) {
    // `unitNo` 是字符串（"1"…"12"），按数值排，否则 "10" 会排在 "2" 前面
    bucket.sort((a, b) => Number(a.unitNo) - Number(b.unitNo) || a.unitNo.localeCompare(b.unitNo));
    for (let index = 1; index < bucket.length; index += 1) {
      const current = bucket[index];
      const previous = bucket[index - 1];
      if (current && previous) result.set(current.id, previous.id);
    }
  }
  return result;
}

// ───────────────────────── 汇总 ─────────────────────────

/** 8 个采集函数，顺序即 `CANDIDATE_SOURCE_KINDS` 的声明顺序。 */
const COLLECTORS: ReadonlyArray<{
  kind: CandidateSourceKind;
  run: (input: CollectCandidatesInput, sink: SkipSink) => Promise<TaskCandidateDraft[]>;
}> = [
  { kind: 'REVIEW', run: collectReviewCandidates },
  { kind: 'RETEST', run: collectRetestCandidates },
  { kind: 'PROBE', run: collectProbeCandidates },
  { kind: 'VOCAB', run: collectVocabCandidates },
  { kind: 'MATERIAL', run: collectMaterialCandidates },
  { kind: 'QUESTION', run: collectQuestionCandidates },
  { kind: 'LAB', run: collectLabCandidates },
  { kind: 'EGIU', run: collectEgiuCandidates },
];

/**
 * 采集 8 源 → 归一候选（**不排序、不去重、不裁剪**）。
 *
 * 去重是 `dedupeCandidates()` 的事，排序是评分层的事。这里只负责"把库里的东西
 * 搬成统一形状"，任何一步提前做都会让下游无法解释结果（"为什么这条没进候选"与
 * "为什么这条排最后"是两个不同的问题）。
 *
 * 单个来源抛错**不拖垮整池**：记进 `degraded` 由上层写进 `validation.missing`。
 * 一个来源挂掉就返回空池，等于因为 EGIU 表读失败而让用户看不到今天的复习。
 */
export async function collectCandidates(input: CollectCandidatesInput): Promise<CollectCandidatesResult> {
  const candidates: TaskCandidateDraft[] = [];
  const skipped: SkippedCandidate[] = [];
  const degraded: CandidateSourceKind[] = [];
  const sink: SkipSink = (skip) => skipped.push(skip);

  for (const collector of COLLECTORS) {
    try {
      const rows = await collector.run(input, sink);
      candidates.push(...rows);
    } catch {
      degraded.push(collector.kind);
    }
  }
  return { candidates, skipped, degraded };
}
