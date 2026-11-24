/**
 * 计划输入快照的装配与落库（T02 §2.1，7 类输入）。
 *
 * 这个服务做三件事，顺序不能换：
 * 1. **装配**：把 7 类输入读齐（目标/预算/阶段/画像/证据/复习复测/候选）。
 * 2. **归一化一次**：`buildCanonicalPlanningInput()` 产出的 `canonical` 既算 hash，
 *    **也**是落库 JSON 的来源 —— 落库值必须是归一化后的值。否则会出现
 *    「hash 相同、快照内容不同」：两轮相差 0.0001 的运行复用同一行旧快照，
 *    而那行里存的是上一轮的值。
 * 3. **幂等落库**：`(purpose, asOfDate, inputHash)` 命中就复用，不新建行。
 *
 * `legacy`（v2.1 引擎输入）**必须填实**：`PlanningSnapshot` 存在的唯一理由是复现
 * 「为什么这样排」，一个不含调度输入的快照会照样写库、照样被 `PlanVersion.snapshotId`
 * 引用，看起来有据可查，实际什么都解释不了。装配复用
 * `queries/planning.loadPlanEngineContext()`（审计 §7.1 认定的唯一输入装配）。
 */

import type { StageCode } from '@/lib/types';
import { addDays, listDateRange, diffDays, endOfBusinessDay, toUtcInstant } from '@/lib/date';
import { STAGE_CODES, WEAKNESS_WINDOW_DAYS } from '@/lib/constants';
import { DEFAULT_WEIGHTS, scoreCandidate, toFactorsJson, type TaskPriorityDecisionDraft } from '@/lib/domain/taskPriority';
import type { PrerequisiteContext, TaskCandidateDraft } from '@/lib/domain/taskCandidate';
import { collectCandidates } from '@/lib/services/candidateSources';
import {
  buildCanonicalPlanningInput,
  parseSkillTargets,
  RULE_VERSION,
  type PlanningLayer,
} from '@/lib/domain/planningSnapshot';
import {
  computeGapSeverity,
  splitGapsAndUncertainty,
  type SkillGapDraft,
  type SkillGapSignal,
} from '@/lib/domain/skillGap';
import { suggestProfileConfidence } from '@/lib/domain/profile';
import { prisma } from '@/lib/prisma';
import { getBudgetRange, getEffectiveBudget, getPlannerSettings } from '@/lib/queries/budget';
import { loadPlanEngineContext } from '@/lib/queries/planning';
import { fail, ok } from '@/lib/result';
import type { ActionResult, EvidenceConfidence, LearningTrack, SkillId } from '@/lib/types';

/** 快照用途（与 `PlanningSnapshot.purpose` 一致）。 */
export const PLANNING_SNAPSHOT_PURPOSES = [
  'GENERATE',
  'REPLAN',
  'WEEKLY',
  'CYCLE_CALIBRATION',
  'READINESS',
] as const;
export type PlanningSnapshotPurpose = (typeof PLANNING_SNAPSHOT_PURPOSES)[number];

/** 缺失输入（blocking = 禁止生成，degraded = 可降级继续）。 */
export interface MissingInputItem {
  key: 'GOAL' | 'BUDGET' | 'STAGE' | 'PROFILE' | 'EVIDENCE' | 'REVIEW' | 'RETEST' | 'CANDIDATES' | 'EXECUTION';
  label: string;
  severity: 'blocking' | 'degraded';
  hint: string;
}

/** 装配结果（内存对象，本次调度直接用）。 */
export interface PlanEngineContextV27 {
  asOfDate: string;
  horizonDays: number;
  stage: { id: string; code: StageCode; profileCode: string | null };
  goal: {
    track: LearningTrack;
    targetValue: string | null;
    targetDate: string | null;
    /**
     * `Partial` 是**刻意**的：未列出的技能表示"不在目标内"，读取侧必须写
     * `?? 0.30`。用 `Record<string, number>` 会让 TS 声称每个键都有值，
     * 而运行时拿到 `undefined` → `goalRelevance` 算术变 `NaN` → 排序静默乱序。
     */
    skillTargets: Partial<Record<SkillId, number>>;
    /**
     * 是否有正在跑的 `LearningCycle`（`CALIBRATION`/`BUILD`/`DELIVER` 且未归档）。
     *
     * 评分层的 `goalRelevance` 靠它决定是"算得出来"还是"不知道"（回落 0.50）：
     * 没有周期就没有 90 天的参照系，用 `diffDays(undefined, …)` 会退化成 0
     * → 公式算出 1.00 → 所有候选满分。显式布尔是唯一安全的传法。
     */
    hasActiveCycle: boolean;
  } | null;
  budget: Awaited<ReturnType<typeof getEffectiveBudget>>;
  budgetDays: { date: string; minutes: number; isRestDay: boolean }[];
  /** v2.1 引擎输入 —— **必填且填实**。 */
  legacy: Awaited<ReturnType<typeof loadPlanEngineContext>>;
  gaps: SkillGapDraft[];
  uncertainties: SkillGapDraft[];
  unknowns: SkillGapDraft[];
  /** T03：8 源归一后的候选（**不排序**，顺序即采集顺序）。 */
  candidates: TaskCandidateDraft[];
  /** T04：与 `candidates` 一一对应的评分决策。 */
  decisions: TaskPriorityDecisionDraft[];
  execution: { last7NetMinutes: number; last30NetMinutes: number; activeDaysLast7: number };
  validation: { ok: boolean; missing: MissingInputItem[]; warnings: string[] };
}

export interface PlanningSnapshotResult {
  snapshotId: string;
  inputHash: string;
  reused: boolean;
  ruleVersion: string;
  weightsVersion: string;
  context: PlanEngineContextV27;
}

export interface BuildPlanningSnapshotInput {
  purpose: PlanningSnapshotPurpose;
  asOfDate: string;
  horizonDays: number;
  stageId?: string;
  /** REPLAN 必填 */
  planDate?: string;
  reuseIfSameHash?: boolean;
  layer?: PlanningLayer | null;
}

/** 官方四项（缺口与画像的 OFFICIAL 维度）。 */
const OFFICIAL_SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;

/** 从 `priorityPolicy` JSON 里取权重版本（缺失回落 v1，与 T04 的默认一致）。 */
function weightsVersionOf(raw: string | null | undefined): string {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    return typeof parsed.weightsVersion === 'string' && parsed.weightsVersion.length > 0
      ? parsed.weightsVersion
      : 'v1';
  } catch {
    return 'v1';
  }
}

/**
 * 装配并落库计划输入快照。
 *
 * @param input 用途 / 基准日 / 视野 / 阶段
 */
export async function buildPlanningSnapshot(
  input: BuildPlanningSnapshotInput,
): Promise<ActionResult<PlanningSnapshotResult>> {
  const missing: MissingInputItem[] = [];
  const warnings: string[] = [];

  // ── ③ 阶段（blocking：PlanTask.stageId 必填） ──
  const stage = input.stageId
    ? await prisma.stage.findUnique({ where: { id: input.stageId } })
    : await prisma.stage.findFirst({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } });
  if (!stage) {
    return fail('PRECONDITION', '还没有激活的学习阶段，无法生成计划（先完成阶段设置）');
  }

  const planDate = input.planDate ?? input.asOfDate;

  // ── ② 预算（唯一入口） + ⑦ 近期执行 ──
  const budget = await getEffectiveBudget(input.asOfDate);
  const dates = listDateRange(input.asOfDate, addDays(input.asOfDate, Math.max(1, input.horizonDays) - 1));
  const budgetMap = await getBudgetRange(dates);
  const budgetDays = dates.map((date) => {
    const day = budgetMap.get(date);
    return { date, minutes: day?.minutes ?? 0, isRestDay: day?.isRestDay ?? false };
  });
  if (budget.isSuggestion) {
    warnings.push('当日预算仍是初始建议值（用户尚未确认日程配置）');
  }

  // ── v2.1 引擎输入（必填，缺失即阻断） ──
  let legacy: Awaited<ReturnType<typeof loadPlanEngineContext>>;
  try {
    legacy = await loadPlanEngineContext(planDate, {
      id: stage.id,
      code: stage.code,
      profileCode: stage.profileCode,
    });
  } catch (error) {
    return fail(
      'PRECONDITION',
      `调度输入装配失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ── ① 目标（degraded） ──
  // ⚠️ `orderBy` 是**必须**的（`41 §9.1` C-J）：`seedLearningGoals()` 按 `GOAL_TYPES`
  // 建了 3 条 `status='ACTIVE'` 的目标，没有排序时取到哪一条由 SQLite 的插入顺序决定
  // —— 而 `goalRelevance` 的两个输入（`targetDate` / `skillTargets`）都来自这一行。
  // 取错目标 = 相关度算错，且**没有任何报错**；换台机器结果就变。
  // "三条 ACTIVE 本身可疑"是数据问题（不在本改动范围）；这里只保证**取哪一条是确定的**。
  const goalRow = await prisma.learningGoal.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  // 有在跑的周期 = `CALIBRATION|BUILD|DELIVER` 且未归档。评分层的 `goalRelevance`
  // 只在有周期时才敢用 90 天公式（见 `domain/taskPriority.ts` 的注释）。
  const activeCycle = await prisma.learningCycle.findFirst({
    where: { archivedAt: null, status: { in: ['CALIBRATION', 'BUILD', 'DELIVER'] } },
    select: { id: true },
  });
  const goal = goalRow
    ? {
        track: 'IELTS_PREPARATION' as LearningTrack,
        targetValue: goalRow.targetValue,
        targetDate: goalRow.targetDate,
        // 这里**刻意不**先 `.filter(v => typeof v === 'number')`：
        // `LearningGoal.min*` 是 `Float?`，null 会经 `Object.fromEntries` 原样进来，
        // 而 `parseSkillTargets()` 自己就负责把它们丢掉（A-4：守卫在函数入口，
        // 不在调用方）。留着那道 filter 会让人以为函数离不开它 —— 下一个调用点
        // 就不会知道要写，而函数那时仍然"看起来是对的"。
        skillTargets: parseSkillTargets(
          Object.fromEntries([
            ['LISTENING', goalRow.minListening],
            ['READING', goalRow.minReading],
            ['WRITING', goalRow.minWriting],
            ['SPEAKING', goalRow.minSpeaking],
          ] as const),
        ),
        hasActiveCycle: Boolean(activeCycle),
      }
    : null;
  if (!goal) {
    missing.push({
      key: 'GOAL',
      label: '学习目标',
      severity: 'degraded',
      hint: '在「目标」页设定目标类型与分数，计划才能按目标相关度排序（当前只能纯时间驱动）',
    });
  }

  // ── ④⑤ 画像 + 证据 → 缺口信号 ──
  const [profiles, evidenceRows] = await Promise.all([
    prisma.skillProfile.findMany({ where: { skill: { in: [...OFFICIAL_SKILLS] } } }),
    prisma.evidenceRecord.findMany({
      where: { skill: { in: [...OFFICIAL_SKILLS] } },
      select: {
        id: true,
        skill: true,
        evidenceType: true,
        assistanceLevel: true,
        score: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
  ]);
  /**
   * 近 28 天的错题（`Mistake`）按技能聚合成 `repeatedErrorCount`（`41 §9.1` C-H 的另一半）。
   *
   * 三个细节：
   * 1. **窗口按 `asOfDate` 算，不是按 `Date.now()`**：否则同一 `asOfDate` 在不同时刻
   *    跑出不同 hash，快照幂等与"历史可复算"同时失效。
   * 2. **只统计能归属到 `StudyRecord` 的错题**：`Mistake` 表没有 skill 列，技能只能从
   *    `studyRecord.skill` 拿到；手工录入、没挂记录的错题归不了维度，宁可漏计也不错挂。
   * 3. `?? 0` 在这里是**对的**：窗口内该技能没有错题就是"确认为无重复错误"，
   *    而"这个维度根本没练过"由 `evidenceQuestions === 0` 表达，两者在评分层分开处理。
   */
  const windowStart = toUtcInstant(addDays(input.asOfDate, -(WEAKNESS_WINDOW_DAYS - 1)));
  const windowEnd = endOfBusinessDay(input.asOfDate);
  const mistakeRows = await prisma.mistake.findMany({
    where: { archivedAt: null, createdAt: { gte: windowStart, lte: windowEnd } },
    select: { studyRecord: { select: { skill: true } } },
  });
  const repeatedBySkill = new Map<string, number>();
  for (const row of mistakeRows) {
    const skill = row.studyRecord?.skill;
    if (!skill) continue;
    repeatedBySkill.set(skill, (repeatedBySkill.get(skill) ?? 0) + 1);
  }

  if (profiles.length === 0) {
    missing.push({
      key: 'PROFILE',
      label: '技能画像',
      severity: 'degraded',
      hint: '做一次诊断或在「画像」页记录一次评估，四技能才有方向（当前一律按 UNKNOWN 处理）',
    });
  }
  if (evidenceRows.length === 0) {
    missing.push({
      key: 'EVIDENCE',
      label: '能力证据',
      severity: 'degraded',
      hint: '任何一次练习/模考都会产生证据；没有证据时只排复习与时间驱动核心',
    });
  }

  const signals: SkillGapSignal[] = OFFICIAL_SKILLS.map((skill) => {
    const rows = evidenceRows.filter((row) => row.skill === skill);
    const independent = rows.filter((row) => row.assistanceLevel === 'A0');
    const scored = rows.filter((row) => typeof row.score === 'number');
    const latest = rows[0]?.createdAt ?? null;
    const confidence = (profiles.find((row) => row.skill === skill)?.confidence ??
      'LOW') as EvidenceConfidence;
    // 置信度判定复用 `domain/profile`，这里只把证据行投影成它要的形状
    const suggestion = suggestProfileConfidence(
      // 库里是自由字符串（SQLite 无 enum），这里靠 profile 层的入参类型收窄
      rows.map(
        (row) =>
          ({ evidenceType: row.evidenceType, assistanceLevel: row.assistanceLevel }) as Parameters<
            typeof suggestProfileConfidence
          >[0][number],
      ),
    );
    return {
      dimensionKind: 'OFFICIAL',
      skill,
      subskill: '',
      profileConfidence: confidence,
      independentCount: independent.length,
      evidenceCount: rows.length,
      evidenceQuestions: scored.length,
      freshnessDays: latest ? diffDays(latest.toISOString().slice(0, 10), input.asOfDate) : null,
      coverageRatio: null,
      // `accuracyDelta` 仍缺真值（需要分题型正确率，当前证据行没有这个维度）→ `null` = 不知道；
      // 不能传 0，那等于告诉严重度公式"已确认该维度没有任何问题"
      accuracyDelta: null,
      repeatedErrorCount: repeatedBySkill.get(skill) ?? 0,
      evidenceIds: rows.slice(0, 20).map((row) => row.id),
      missingEvidence: suggestion.gaps,
    };
  });

  const split = splitGapsAndUncertainty(signals);

  // ── ⑥ 复习/复测（来自 legacy，原样复用；它已经是唯一装配） ──
  // `DueReviewInput` / `DueRetestInput` 是对象（不是数组），这里只判"有没有东西"
  const hasContent = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : Boolean(value);
  if (!hasContent(legacy.dueReviews) && !hasContent(legacy.dueRetests)) {
    warnings.push('近 7 天没有到期复习/复测项（若预期有，请检查到期日设置）');
  }

  // ── ⑦ 近期执行（只读 DaySplit，不读 actualMinutes 快照） ──
  const [last7, last30] = await Promise.all([
    prisma.studySessionDaySplit.aggregate({
      where: { date: { gte: addDays(input.asOfDate, -6), lte: input.asOfDate } },
      _sum: { minutes: true },
    }),
    prisma.studySessionDaySplit.aggregate({
      where: { date: { gte: addDays(input.asOfDate, -29), lte: input.asOfDate } },
      _sum: { minutes: true },
    }),
  ]);
  const activeDaysLast7 = await prisma.studySessionDaySplit
    .groupBy({ by: ['date'], where: { date: { gte: addDays(input.asOfDate, -6), lte: input.asOfDate } } })
    .then((rows) => rows.length);
  const execution = {
    last7NetMinutes: last7._sum.minutes ?? 0,
    last30NetMinutes: last30._sum.minutes ?? 0,
    activeDaysLast7,
  };

  // ── 配置（先于候选采集：评分要用 `minTaskMinutes` 与 `weightsVersion`） ──
  const settings = await getPlannerSettings();
  const weightsVersion = weightsVersionOf(settings?.priorityPolicy);
  const config = {
    minTaskMinutes: settings?.minTaskMinutes ?? 5,
    weightsVersion,
    gapMinSeverity: 0.15,
    profileReviewDays: { LOW: 14, MEDIUM: 30, HIGH: 90 },
  };

  // ── ⑧ 候选池（T03）+ 评分（T04） ──
  // `gaps` 传全部三组：`PROBE` 只认 `kind='UNCERTAINTY'`，而 `gapOf()` 按
  // `dimensionKind:skill:subskill` 找缺口，漏掉任何一组都会让某类候选拿不到证据强度。
  const allGaps = [...split.gaps, ...split.uncertainties, ...split.unknowns];
  const collected = await collectCandidates({ asOfDate: input.asOfDate, gaps: allGaps });
  if (collected.degraded.length > 0) {
    missing.push({
      key: 'CANDIDATES',
      label: '候选任务池',
      severity: 'degraded',
      hint: `以下来源读取失败，今天的候选池可能不完整：${collected.degraded.join('、')}`,
    });
  } else if (collected.candidates.length === 0) {
    missing.push({
      key: 'CANDIDATES',
      label: '候选任务池',
      severity: 'degraded',
      hint: '今天没有可排的候选（到期复习/复测、材料草案、题库、听说、EGIU 都没有命中入池条件）',
    });
  }

  const prerequisites = await buildPrerequisiteContext(collected.candidates, stage.code as StageCode);
  const decisions = collected.candidates.map((row) =>
    scoreCandidate(row, {
      asOfDate: input.asOfDate,
      budgetMinutes: budget.minutes,
      minTaskMinutes: config.minTaskMinutes,
      goal,
      gaps: allGaps,
      weights: DEFAULT_WEIGHTS,
      weightsVersion,
      prerequisites,
    }),
  );

  // ── 归一化一次：hash 与落库共用同一个对象（约束⑦） ──
  const { canonical, hash } = buildCanonicalPlanningInput({
    weightsVersion,
    config,
    purpose: input.purpose,
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
    layer: input.layer ?? null,
    stage: { code: stage.code, profileCode: stage.profileCode },
    goal,
    budget: {
      minutes: budget.minutes,
      tierCode: budget.tierCode,
      isRestDay: budget.isRestDay,
      source: budget.source,
      isInitialSuggestion: budget.isSuggestion,
    },
    budgetDays,
    gaps: split.gaps,
    uncertainties: split.uncertainties,
    unknowns: split.unknowns,
    dueReviews: legacy.dueReviews,
    dueRetests: legacy.dueRetests,
    execution,
    candidates: collected.candidates,
    decisions,
    validation: { missing, warnings },
    replan:
      input.purpose === 'REPLAN'
        ? { planDate, existingTaskKeys: [], actualMinutesToday: null }
        : null,
  });

  const validation = { ok: true, missing, warnings };
  const context: PlanEngineContextV27 = {
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
    stage: { id: stage.id, code: stage.code as StageCode, profileCode: stage.profileCode },
    goal,
    budget,
    budgetDays,
    legacy,
    gaps: split.gaps,
    uncertainties: split.uncertainties,
    unknowns: split.unknowns,
    candidates: collected.candidates,
    decisions,
    execution,
    validation,
  };

  const existing = await prisma.planningSnapshot.findUnique({
    where: {
      purpose_asOfDate_inputHash: {
        purpose: input.purpose,
        asOfDate: input.asOfDate,
        inputHash: hash,
      },
    },
    select: { id: true },
  });

  if (existing && (input.reuseIfSameHash ?? true)) {
    const gapCount = await prisma.skillGap.count({ where: { snapshotId: existing.id } });
    if (gapCount === 0) await persistGaps(existing.id, split);
    // 与缺口同理：复用路径也要保证候选/决策已落库（可能是上一版只写了快照行）
    const candidateCount = await prisma.taskCandidate.count({ where: { snapshotId: existing.id } });
    if (candidateCount === 0) await persistCandidates(existing.id, collected.candidates, decisions);
    return ok({
      snapshotId: existing.id,
      inputHash: hash,
      reused: true,
      ruleVersion: RULE_VERSION,
      weightsVersion,
      context,
    });
  }

  const snapshotId = await prisma.$transaction(async (tx) => {
    const row = await tx.planningSnapshot.create({
      data: {
        purpose: input.purpose,
        asOfDate: input.asOfDate,
        inputHash: hash,
        ruleVersion: RULE_VERSION,
        // 落库值一律取归一化后的对象（约束⑦：不能「哈希归一值、落库原值」）
        budgetJson: JSON.stringify(canonical.budget ?? null),
        profileJson: JSON.stringify({
          profiles: [...profiles],
          gaps: split.gaps,
          uncertainties: split.uncertainties,
          unknowns: split.unknowns,
        }),
        workloadJson: JSON.stringify(canonical.execution ?? null),
        candidatesJson: JSON.stringify(canonical.candidates ?? []),
        configJson: JSON.stringify(canonical.config ?? null),
        validationJson: JSON.stringify(canonical.validation ?? null),
      },
      select: { id: true },
    });
    return row.id;
  });

  // 顺序固定：缺口先落库，候选靠 `dimensionKind:skill:subskill` 反查 `SkillGap.id`
  await persistGaps(snapshotId, split);
  await persistCandidates(snapshotId, collected.candidates, decisions);

  return ok({
    snapshotId,
    inputHash: hash,
    reused: false,
    ruleVersion: RULE_VERSION,
    weightsVersion,
    context,
  });
}

/**
 * 前置条件判定上下文：**只查候选真正引用到的 id**。
 *
 * 不写"把整张表读进来"，因为那会随数据量增长而变慢；也不写"逐条查"，那是 N+1。
 * 折中：先把候选的 `prerequisites` 里出现的 id 收成五个集合，再一次 `in` 查回、
 * 用查询时带的状态条件筛出"真的满足"的那些。
 *
 * ⚠️ 每个集合的**判定条件**必须写在这里而不是散在采集层：
 * - 材料就绪 = `status ∈ {ready, partial}`（`partial` 也算：用户明确接受过降级）
 * - 题目可用 = `reviewStatus='approved'`（草稿/待审一律不算）
 * - 转写确认 = `status='CONFIRMED'`（机器草稿不算，这是 AC-2 的同一条口径）
 * - 单元完成 = `currentColor='GREEN'`（黄/红都不算学完）
 * - 证据存在 = 未归档
 */
async function buildPrerequisiteContext(
  candidates: readonly TaskCandidateDraft[],
  stageCode: StageCode,
): Promise<PrerequisiteContext> {
  const referenced = { materials: new Set<string>(), exercises: new Set<string>(), audio: new Set<string>(), lessons: new Set<string>(), evidences: new Set<string>() };
  for (const candidate of candidates) {
    for (const item of candidate.prerequisites) {
      if (item.kind === 'MATERIAL_READY') referenced.materials.add(item.materialId);
      else if (item.kind === 'EXERCISE_APPROVED') referenced.exercises.add(item.exerciseId);
      else if (item.kind === 'TRANSCRIPT_CONFIRMED') referenced.audio.add(item.audioAssetId);
      else if (item.kind === 'UNIT_ORDER') referenced.lessons.add(item.requiresLessonId);
      else if (item.kind === 'EVIDENCE_EXISTS') referenced.evidences.add(item.evidenceId);
    }
  }
  const stageOrder: Record<string, number> = {};
  STAGE_CODES.forEach((code, index) => {
    stageOrder[code] = index;
  });
  const base: PrerequisiteContext = {
    stageCode,
    stageOrder,
    readyMaterialIds: new Set(),
    approvedExerciseIds: new Set(),
    confirmedTranscriptAssetIds: new Set(),
    completedLessonIds: new Set(),
    evidenceIds: new Set(),
  };
  const anyReferenced =
    referenced.materials.size + referenced.exercises.size + referenced.audio.size + referenced.lessons.size + referenced.evidences.size > 0;
  if (!anyReferenced) return base;

  const [materials, exercises, transcripts, lessons, evidences] = await Promise.all([
    prisma.learningMaterial.findMany({
      where: { id: { in: [...referenced.materials] }, status: { in: ['ready', 'partial'] } },
      select: { id: true },
    }),
    prisma.generatedExercise.findMany({
      where: { id: { in: [...referenced.exercises] }, reviewStatus: 'approved' },
      select: { id: true },
    }),
    prisma.transcript.findMany({
      where: { audioAssetId: { in: [...referenced.audio] }, status: 'CONFIRMED' },
      select: { audioAssetId: true },
    }),
    prisma.egiuLesson.findMany({
      where: { id: { in: [...referenced.lessons] }, currentColor: 'GREEN' },
      select: { id: true },
    }),
    prisma.evidenceRecord.findMany({
      where: { id: { in: [...referenced.evidences] }, archivedAt: null },
      select: { id: true },
    }),
  ]);
  return {
    ...base,
    readyMaterialIds: new Set(materials.map((row) => row.id)),
    approvedExerciseIds: new Set(exercises.map((row) => row.id)),
    confirmedTranscriptAssetIds: new Set(
      transcripts.flatMap((row) => (row.audioAssetId ? [row.audioAssetId] : [])),
    ),
    completedLessonIds: new Set(lessons.map((row) => row.id)),
    evidenceIds: new Set(evidences.map((row) => row.id)),
  };
}

/**
 * 候选与决策落库。
 *
 * 两条形状上的约束：
 * 1. **`factorsJson` 由 `toFactorsJson()` 产出**，服务层不自己拼 JSON —— 平铺的后果
 *    （`NaN` → 排序静默乱序）在运行时看不见，只有"只有一个地方能产出这个形状"才挡得住。
 * 2. `skillGapId` 用 `dimensionKind:skill:subskill` 反查已落库的 `SkillGap` 行：
 *    不建跨域外键，但**仍然**把关系填上，否则解释面板要再查一次。
 *
 * @param snapshotId 快照 id
 * @param candidates 归一候选
 * @param decisions 与候选一一对应的决策
 */
async function persistCandidates(
  snapshotId: string,
  candidates: readonly TaskCandidateDraft[],
  decisions: readonly TaskPriorityDecisionDraft[],
): Promise<void> {
  if (candidates.length === 0) return;
  const gapRows = await prisma.skillGap.findMany({
    where: { snapshotId },
    select: { id: true, dimensionKind: true, skill: true, subskill: true },
  });
  const gapIdByKey = new Map<string, string>(
    gapRows.map((row) => [`${row.dimensionKind}:${row.skill}:${row.subskill}`, row.id]),
  );
  const decisionByKey = new Map(decisions.map((row) => [row.candidateKey, row] as const));

  await prisma.$transaction(async (tx) => {
    for (const candidate of candidates) {
      const skillGapId = candidate.skillGapKey ? (gapIdByKey.get(candidate.skillGapKey) ?? null) : null;
      const created = await tx.taskCandidate.create({
        data: {
          snapshotId,
          sourceKind: candidate.sourceKind,
          sourceRef: candidate.sourceRef,
          candidateKey: candidate.candidateKey,
          module: candidate.module,
          targetSkill: candidate.targetSkill,
          skillGapId,
          title: candidate.title,
          estMinutes: candidate.estMinutes,
          minMinutes: candidate.minMinutes,
          maxBlockMinutes: candidate.maxBlockMinutes,
          prerequisitesJson: JSON.stringify(candidate.prerequisites),
          validationStatus: candidate.validationStatus,
          difficultyScore: candidate.difficultyScore,
          isAiSuggested: candidate.isAiSuggested,
          aiCallLogId: candidate.aiCallLogId,
        },
        select: { id: true },
      });
      const decision = decisionByKey.get(candidate.candidateKey);
      if (!decision) continue;
      await tx.taskPriorityDecision.create({
        data: {
          candidateId: created.id,
          snapshotId,
          skillGapId,
          weightsVersion: decision.weightsVersion,
          factorsJson: JSON.stringify(toFactorsJson(decision)),
          score: decision.score,
          priority: decision.priority,
          rationale: decision.rationale,
          consequenceIfSkipped: decision.consequenceIfSkipped,
          eligibility: decision.eligibility,
          blockedReason: decision.blockedReason,
        },
      });
    }
  });
}

/**
 * 缺口落库（一个维度一行；`stale` **不落库**，它是派生 DTO 字段）。
 *
 * @param snapshotId 快照 id
 * @param split 判定结果
 */
async function persistGaps(
  snapshotId: string,
  split: { gaps: SkillGapDraft[]; uncertainties: SkillGapDraft[]; unknowns: SkillGapDraft[] },
): Promise<void> {
  const all = [...split.gaps, ...split.uncertainties, ...split.unknowns];
  if (all.length === 0) return;
  await prisma.skillGap.createMany({
    data: all.map((gap) => ({
      snapshotId,
      dimensionKind: gap.dimensionKind,
      skill: gap.skill,
      subskill: gap.subskill,
      kind: gap.kind,
      confidence: gap.confidence,
      evidenceCount: gap.evidenceCount,
      independentCount: gap.independentCount,
      freshnessDays: gap.freshnessDays,
      coverageRatio: gap.coverageRatio,
      severity: gap.severity,
      reason: gap.reason,
      evidenceIdsJson: JSON.stringify(gap.evidenceIds),
      missingEvidenceJson: JSON.stringify(gap.missingEvidence),
      status: 'PENDING',
    })),
  });
}

/** 供测试与调用方复用的严重度入口（避免两处公式）。 */
export { computeGapSeverity };
