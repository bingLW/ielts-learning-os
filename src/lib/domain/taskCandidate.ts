/**
 * 候选任务的**归一与去重**（T03，8 源）。
 *
 * 两条贯穿本文件的原则：
 *
 * 1. **身份 ≠ 载荷**。`candidateKey` 只描述"要做什么"（来源 + 源行 + 模块），
 *    不描述"要花多久"。`estMinutes` 是载荷：它随用户改时长、随默认派生表调整而变，
 *    放身份里会让"上周那条阅读细节题"和"这周那条"变成两个 key，
 *    跨快照比对与幂等复用全部失配。
 * 2. **去重不能靠身份**。`REVIEW` 与 `PROBE` 指向同一维度时，`sourceRef` 天生不同，
 *    按 `candidateKey` 分组永远合不起来 —— 所以另有一个 `dedupeGroup`（见 `dedupeGroupOf`）。
 *
 * 反过来，`dedupe` 也**不允许过度合并**：`QUESTION`/`LAB`/`EGIU` 各处内容不同，
 * 合并会让用户少看到任务还以为系统就是这样安排的。
 */

import type { LearningTrack, ModuleId, PrimarySkill, SkillId, StageCode } from '../types';

/** 8 个候选来源（顺序即去重保留优先级：越靠前越优先保留）。 */
export const CANDIDATE_SOURCE_KINDS = [
  'REVIEW',
  'RETEST',
  'PROBE',
  'VOCAB',
  'MATERIAL',
  'QUESTION',
  'LAB',
  'EGIU',
] as const;
export type CandidateSourceKind = (typeof CANDIDATE_SOURCE_KINDS)[number];

/** 组内保留优先级（数字越小越优先）。 */
export const CANDIDATE_SOURCE_PRIORITY: Record<CandidateSourceKind, number> = {
  REVIEW: 0,
  RETEST: 1,
  PROBE: 2,
  MATERIAL: 3,
  VOCAB: 4,
  QUESTION: 5,
  LAB: 6,
  EGIU: 7,
};

/** 前置条件（判定"能不能现在排"）。 */
export type Prerequisite =
  | { kind: 'STAGE_AT_LEAST'; code: StageCode }
  | { kind: 'MATERIAL_READY'; materialId: string }
  | { kind: 'EXERCISE_APPROVED'; exerciseId: string }
  | { kind: 'TRANSCRIPT_CONFIRMED'; audioAssetId: string }
  | { kind: 'UNIT_ORDER'; lessonId: string; requiresLessonId: string }
  | { kind: 'EVIDENCE_EXISTS'; evidenceId: string };

/** 前置条件的判定上下文（由服务层读库后传入；本模块不碰 IO）。 */
export interface PrerequisiteContext {
  stageCode: StageCode;
  stageOrder: Record<string, number>;
  readyMaterialIds: ReadonlySet<string>;
  approvedExerciseIds: ReadonlySet<string>;
  confirmedTranscriptAssetIds: ReadonlySet<string>;
  completedLessonIds: ReadonlySet<string>;
  evidenceIds: ReadonlySet<string>;
}

/** 一条归一后的候选。 */
export interface TaskCandidateDraft {
  /** 身份键：`sourceKind:sourceRef|none:module`（**不含时长**）。 */
  candidateKey: string;
  sourceKind: CandidateSourceKind;
  sourceRef: string | null;
  module: ModuleId;
  targetSkill: SkillId;
  primarySkill: PrimarySkill;
  track: LearningTrack;
  /** `${dimensionKind}:${skill}:${subskill}`（关联缺口；无则 null） */
  skillGapKey: string | null;
  title: string;
  estMinutes: number;
  minMinutes: number;
  maxBlockMinutes: number | null;
  prerequisites: Prerequisite[];
  validationStatus: 'VERIFIED' | 'RUBRIC' | 'AI_PRACTICE' | 'UNVERIFIED';
  difficultyScore: number | null;
  /** 初始恒 false；只有 AI 层可置 true（UI 必须能区分） */
  isAiSuggested: boolean;
  aiCallLogId: string | null;
  expectedOutput: string | null;
  /** 载荷来源标注：真实字段 vs 派生默认表（审计用，不参与身份） */
  meta: { estMinutesSource: 'SOURCE' | 'DERIVED'; derivedFrom?: string };
}

/**
 * `QUESTION` 来源的两条链路（必须可辨：一个是诊断题，一个是材料题）。
 */
export type QuestionChain = 'diagnostic' | 'material_exercise';

/** `LAB` 来源的两条链路（听力 / 口语靠前缀区分，与 `LISTENING_MODES`+`SPEAKING_TASK_TYPES` 对应）。 */
export type LabChain = 'listening' | 'speaking';

/** 各来源的 `sourceRef` 前缀。**唯一真相**，别处不许手写字符串。 */
const SOURCE_REF_PREFIX: Record<CandidateSourceKind, string> = {
  REVIEW: 'review',
  RETEST: 'retest',
  PROBE: 'probe',
  VOCAB: 'vocab',
  MATERIAL: 'material',
  QUESTION: 'diagnostic',
  LAB: 'listening',
  EGIU: 'egiu',
};

/**
 * 生成 `sourceRef`（源行弱引用）。
 *
 * **必须收敛到这一处**：`sourceRef` 同时是三个东西的输入 ——
 * `candidateKey`（身份）、`dedupeGroupOf` 的 `material:`/`vocab:` 分组、
 * 以及徽章解析里的 `listening:`/`speaking:` 前缀。
 *
 * 8 个采集函数各写一遍字符串，迟早出现 `listening:<id>` / `listening|id` /
 * `listening#<id>` 三种写法并存；而身份字段一旦分叉，跨快照比对与去重分组会**同时**
 * 静默失效 —— 表现只是"历史里找不到这个候选了"，没有任何报错。
 *
 * @param kind 来源
 * @param id 源行主键（`probe` 时传 `skill`）
 * @param extra `probe` 传 `subskill`；`question` 传链路；`lab` 传 listening/speaking
 */
export function sourceRefOf(
  kind: CandidateSourceKind,
  id: string,
  extra?: string,
): string {
  const prefix = SOURCE_REF_PREFIX[kind];
  if (kind === 'PROBE') return `${prefix}:${id}|${extra ?? ''}`;
  if (kind === 'QUESTION') return `${extra ?? prefix}:${id}`;
  if (kind === 'LAB') return `${extra ?? prefix}:${id}`;
  return `${prefix}:${id}`;
}

/**
 * 候选身份键。
 *
 * **不含 `estMinutes`**：它是载荷。改时长（用户改、默认表改）不该让"同一件事"
 * 变成两个候选。
 *
 * @param c 至少含来源、源行、模块
 */
export function candidateKeyOf(
  c: Pick<TaskCandidateDraft, 'sourceKind' | 'sourceRef' | 'module'>,
): string {
  return `${c.sourceKind}:${c.sourceRef ?? 'none'}:${c.module}`;
}

/** 缺口键（与 `SkillGap` 的 `dimensionKind|skill|subskill` 同构，用 `:` 连接）。 */
export function gapKeyOf(dimensionKind: string, skill: string, subskill: string): string {
  return `${dimensionKind}:${skill}:${subskill}`;
}

/**
 * 去重分组（**不落库**，纯 DTO 计算）。
 *
 * 为什么不能直接用 `candidateKey` 分组：`REVIEW` 与 `PROBE` 指向同一维度时
 * `sourceRef` 天生不同（`review:<id>` vs `probe:<skill>|<subskill>`），
 * 按 key 分组会让"同一件工作"永远合不起来。
 *
 * 反之，`QUESTION`/`LAB`/`EGIU` 各处内容不同，**必须按 `candidateKey` 各自成组**。
 *
 * @param c 候选
 */
export function dedupeGroupOf(c: TaskCandidateDraft): string {
  switch (c.sourceKind) {
    case 'REVIEW':
    case 'RETEST':
    case 'PROBE':
      // 证据类任务：同一维度视为同一件工作，与来源链路无关
      // 有缺口维度时才按维度合并（同一维度 = 同一件工作）。
      //
      // 没有缺口时回落 `candidateKey`（各走各的），**不能**用
      // `evidence:<targetSkill>:<module>` 这种粗组：`ReviewTask` 表没有 skill/subskill
      // 列（只有 targetType/targetId/knowledgePoint/intervalCode），所以绝大多数复习项
      // 的 `skillGapKey` 天生为 null —— 粗组会把"今天到期的 5 条词汇复习"合成 1 条，
      // 用户少看到 4 条任务，还以为系统本来就这么安排。
      return c.skillGapKey ? `evidence:${c.skillGapKey}` : c.candidateKey;
    case 'MATERIAL':
      return `material:${c.sourceRef ?? 'none'}`;
    case 'VOCAB':
      return `vocab:${c.sourceRef ?? 'none'}`;
    default:
      return c.candidateKey;
  }
}

/** 一条被丢弃的候选及原因。 */
export interface DroppedCandidate {
  candidateKey: string;
  sourceKind: CandidateSourceKind;
  why: string;
}

export interface DedupeResult {
  kept: TaskCandidateDraft[];
  dropped: DroppedCandidate[];
}

/**
 * 按 `dedupeGroup` 去重，组内保留优先级最高的来源。
 *
 * `why` 必须写清"被谁合并"而不是只写"重复" —— 用户看到"少了 3 条"时，
 * 唯一能解释的就是这句话。
 *
 * @param list 归一后的候选（顺序不变，输出按输入首次出现顺序）
 */
export function dedupeCandidates(list: readonly TaskCandidateDraft[]): DedupeResult {
  const byGroup = new Map<string, TaskCandidateDraft[]>();
  for (const candidate of list) {
    const group = dedupeGroupOf(candidate);
    const bucket = byGroup.get(group) ?? [];
    bucket.push(candidate);
    byGroup.set(group, bucket);
  }

  const dropped: DroppedCandidate[] = [];
  const winners = new Set<TaskCandidateDraft>();

  for (const [group, bucket] of byGroup) {
    const kinds = new Set(bucket.map((row) => row.sourceKind));
    if (kinds.size === 1) {
      /**
       * 同组内来源相同 → **全部保留**。
       *
       * 优先级表只能裁决「不同来源指向同一件工作」（`REVIEW` vs `PROBE`），
       * 裁决不了「同一来源的两件工作」。例：两条 `RETEST` 指向同一 `skill/subskill`、
       * 但父证据不同 —— 那是两件活。按优先级并列处理会丢掉后到的那条，
       * 而"并列时保留先到的"就是静默丢数据。
       */
      for (const row of bucket) winners.add(row);
      continue;
    }

    const bestKind = bucket.reduce((best, row) =>
      CANDIDATE_SOURCE_PRIORITY[row.sourceKind] < CANDIDATE_SOURCE_PRIORITY[best.sourceKind]
        ? row
        : best,
    ).sourceKind;
    const keeper = bucket.find((row) => row.sourceKind === bestKind);
    for (const row of bucket) {
      if (row.sourceKind === bestKind) {
        winners.add(row);
        continue;
      }
      dropped.push({
        candidateKey: row.candidateKey,
        sourceKind: row.sourceKind,
        why: keeper
          ? `与 ${keeper.sourceKind}「${keeper.title}」是同一件事（${group}），保留优先级更高的 ${bestKind}`
          : `与同组的 ${bestKind} 是同一件事（${group}），保留优先级更高的 ${bestKind}`,
      });
    }
  }

  // 输出顺序按输入顺序（先到先出），保证确定性
  const kept = list.filter((row) => winners.has(row));
  return { kept, dropped };
}

/**
 * 判定前置条件是否满足。
 *
 * @param prerequisites 前置条件
 * @param ctx 判定上下文
 */
export function evaluatePrerequisites(
  prerequisites: readonly Prerequisite[],
  ctx: PrerequisiteContext,
): { ready: boolean; unmet: Prerequisite[] } {
  const unmet = prerequisites.filter((item) => {
    switch (item.kind) {
      case 'STAGE_AT_LEAST':
        // 阶段是线性推进的：只要当前阶段的序号 ≥ 要求即可
        return (ctx.stageOrder[ctx.stageCode] ?? 0) < (ctx.stageOrder[item.code] ?? 0);
      case 'MATERIAL_READY':
        return !ctx.readyMaterialIds.has(item.materialId);
      case 'EXERCISE_APPROVED':
        return !ctx.approvedExerciseIds.has(item.exerciseId);
      case 'TRANSCRIPT_CONFIRMED':
        return !ctx.confirmedTranscriptAssetIds.has(item.audioAssetId);
      case 'UNIT_ORDER':
        return !ctx.completedLessonIds.has(item.requiresLessonId);
      case 'EVIDENCE_EXISTS':
        return !ctx.evidenceIds.has(item.evidenceId);
      default:
        return true;
    }
  });
  return { ready: unmet.length === 0, unmet };
}
