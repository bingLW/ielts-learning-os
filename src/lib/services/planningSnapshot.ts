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
import { addDays, listDateRange, diffDays } from '@/lib/date';
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
  } | null;
  budget: Awaited<ReturnType<typeof getEffectiveBudget>>;
  budgetDays: { date: string; minutes: number; isRestDay: boolean }[];
  /** v2.1 引擎输入 —— **必填且填实**。 */
  legacy: Awaited<ReturnType<typeof loadPlanEngineContext>>;
  gaps: SkillGapDraft[];
  uncertainties: SkillGapDraft[];
  unknowns: SkillGapDraft[];
  /** T03 注入（本任务为空，且必须在 validation.missing 里可见）。 */
  candidates: unknown[];
  /** T04 注入。 */
  decisions: unknown[];
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
  const goalRow = await prisma.learningGoal.findFirst({ where: { status: 'ACTIVE' } });
  const goal = goalRow
    ? {
        track: 'IELTS_PREPARATION' as LearningTrack,
        targetValue: goalRow.targetValue,
        targetDate: goalRow.targetDate,
        skillTargets: parseSkillTargets(Object.fromEntries(
          (
            [
              ['LISTENING', goalRow.minListening],
              ['READING', goalRow.minReading],
              ['WRITING', goalRow.minWriting],
              ['SPEAKING', goalRow.minSpeaking],
            ] as const
          ).filter(([, value]) => typeof value === 'number'),
        )),
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
      // 这两项由 T04 的 weakness 聚合提供；在此之前传 null（= 不知道），
      // 不能传 0 —— 那等于告诉严重度公式"已确认该维度没有任何问题"
      accuracyDelta: null,
      repeatedErrorCount: null,
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

  // ── T03/T04 才能产出的两项：留空但必须可见 ──
  missing.push({
    key: 'CANDIDATES',
    label: '候选任务池',
    severity: 'degraded',
    hint: '候选池由 T03 产出；在此之前计划无法按候选排序，只能排固定核心',
  });

  const settings = await getPlannerSettings();
  const weightsVersion = weightsVersionOf(settings?.priorityPolicy);
  const config = {
    minTaskMinutes: settings?.minTaskMinutes ?? 5,
    weightsVersion,
    gapMinSeverity: 0.15,
    profileReviewDays: { LOW: 14, MEDIUM: 30, HIGH: 90 },
  };

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
    candidates: [],
    decisions: [],
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
    candidates: [],
    decisions: [],
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

  await persistGaps(snapshotId, split);

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
