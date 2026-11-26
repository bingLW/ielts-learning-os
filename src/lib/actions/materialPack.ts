'use server';

/**
 * 材料包与任务草案的五个 Server Action（T13 §4）。
 *
 * 这一层只做四件事 —— ① 前置断言（材料状态、草案状态）；② 调纯函数/服务拿结论
 * （`splitProposalAcrossDays` / `validateProposalAgainstBudget` / `buildMaterialPack`）；
 * ③ 经唯一计划写入者批量提交；④ 结算与失效缓存。它**不自己判断**"怎么拆"
 * （纯函数是唯一决策点），也**不自己建 PlanTask**。
 *
 * 三条硬约束：
 * - **确认整批原子**：选中条目、预算、版本、`planTaskId` 回填与草案状态同事务提交；
 * - **只写 `selected` 的条目**：勾选框是承诺，不是装饰；
 * - **丢弃草案不动 PlanTask**：已经确认落地的任务不能因为丢草案被删。
 */

import { revalidatePath } from 'next/cache';
import { mapCandidateSourceToPlanTask, taskAxesOf } from '@/lib/domain/planWriteMap';
import { appendTaskBatchInTransaction, BudgetGateError } from '@/lib/services/planWrite';
import type { BudgetDay, ProposalSeed } from '@/lib/domain/taskProposal';
import {
  splitProposalAcrossDays,
  validateProposalAgainstBudget,
  type ProposalGranularity,
  type SplitResult,
} from '@/lib/domain/taskProposal';
import { addDays, isValidDateString, listDateRange } from '@/lib/date';
import { getEffectiveBudget } from '@/lib/queries/budget';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  materialPackBuildSchema,
  proposalItemUpdateSchema,
  taskProposalConfirmSchema,
  taskProposalCreateSchema,
  taskProposalDiscardSchema,
} from '@/lib/schema/materialPack';
import { buildMaterialPack } from '@/lib/services/materialPackRepo';
import type { ActionResult, ModuleId } from '@/lib/types';
import type { MaterialStatus } from '@/lib/constants';

/** 允许建包的材料状态（`review_required` 允许建"半成品包"并在页面标注）。 */
const PACKABLE_STATUSES: readonly MaterialStatus[] = ['ready', 'partial', 'review_required'];

/**
 * 草案的天数窗口（基准日起 7 天）。
 *
 * 不 export：「use server」文件只能导出 async 函数，导常量会在构建期报错。
 * 需要这些数字的组件从 `domain/taskProposal` 取。
 */
const PROPOSAL_WINDOW_DAYS = 7;

/** 草案粒度：材料包默认 30 分钟一档。 */
const DEFAULT_PROPOSAL_GRANULARITY: ProposalGranularity = 30;

/** 所有相关页面失效。 */
function revalidatePackPaths(materialId: string): void {
  revalidatePath(`/materials/${materialId}`);
  revalidatePath(`/materials/${materialId}/source`);
  revalidatePath('/materials');
  revalidatePath('/plan');
}

/** 读材料状态（写库后回填 DTO）。 */
async function readStatus(materialId: string): Promise<MaterialStatus | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return (row?.status as MaterialStatus) ?? null;
}

// ───────────────────────── ① 建包 / 重建 ─────────────────────────

export interface BuildPackActionData {
  packId: string;
  rebuilt: boolean;
  itemCount: number;
  estimatedMinutes: number;
  materialStatus: MaterialStatus | null;
  /** 材料还在待审核时建的是"半成品包"，页面要标注。 */
  provisional: boolean;
}

/**
 * 生成（或重建）学习包。
 *
 * @param raw `{ materialId, rebuild? }`
 */
export async function buildMaterialPackAction(
  raw: unknown,
): Promise<ActionResult<BuildPackActionData>> {
  const parsed = materialPackBuildSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, rebuild } = parsed.data;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, status: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const status = material.status as MaterialStatus;
  if (!PACKABLE_STATUSES.includes(status)) {
    return fail('PRECONDITION', '材料还在处理中，等分析完成后再生成学习包');
  }

  const result = await buildMaterialPack(materialId, { rebuild: rebuild === true });
  revalidatePackPaths(materialId);

  return ok<BuildPackActionData>({
    packId: result.packId,
    rebuilt: result.rebuilt,
    itemCount: result.itemCount,
    estimatedMinutes: result.estimatedMinutes,
    materialStatus: await readStatus(materialId),
    provisional: status === 'review_required',
  });
}

// ───────────────────────── ② 生成任务草案 ─────────────────────────

/** 把材料包内容映射成待排入的内容（映射规则集中在 `buildSeedsFromPack`）。 */
async function buildSeedsFromPack(materialId: string): Promise<ProposalSeed[]> {
  const [sets, candidateCount, sentenceCount, chunkCount, summary] = await Promise.all([
    prisma.materialExerciseSet.findMany({
      where: { materialId, isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, targetSkill: true, estimatedMinutes: true, _count: { select: { exercises: true } } },
    }),
    prisma.vocabularyCandidate.count({
      where: { materialId, reviewStatus: { in: ['accepted', 'edited'] } },
    }),
    prisma.extractionResult.count({
      where: { materialId, kind: 'KEY_SENTENCE', reviewStatus: { in: ['accepted', 'edited'] } },
    }),
    prisma.contentChunk.count({ where: { materialId, kind: { in: ['HEADING', 'MIXED'] } } }),
    prisma.extractionResult.findFirst({
      where: { materialId, kind: 'SUMMARY', reviewStatus: { in: ['accepted', 'edited'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
  ]);

  const seeds: ProposalSeed[] = [];

  // 精读：段落多的话按"读全文"一条排出，时长按 5 分钟/段封顶 40 分钟
  if (chunkCount > 0) {
    seeds.push({
      module: 'READING',
      targetSkill: 'READING',
      title: '精读原文段落',
      suggestedMinutes: Math.min(40, chunkCount * 5),
      reason: `本材料有 ${chunkCount} 个可精读段落（标题/综合块）`,
    });
  }

  // 词汇候选聚合成一条 VOCAB_REVIEW
  if (candidateCount > 0) {
    seeds.push({
      module: 'VOCAB_REVIEW',
      targetSkill: 'READING',
      title: '复习材料词汇候选',
      suggestedMinutes: Math.max(10, Math.min(30, Math.ceil(candidateCount / 2) * 5)),
      reason: `${candidateCount} 个已确认的词汇候选待巩固`,
    });
  }

  for (const set of sets) {
    seeds.push({
      module: 'READING',
      targetSkill: set.targetSkill,
      title: `完成练习：${set.title}`,
      suggestedMinutes: Math.max(10, set.estimatedMinutes),
      exerciseIds: [set.id],
      reason: `${set._count.exercises} 道题`,
    });
  }

  if (sentenceCount > 0) {
    seeds.push({
      module: 'SENTENCE',
      targetSkill: 'READING',
      title: '精析重点句',
      suggestedMinutes: Math.min(30, sentenceCount * 5),
      reason: `${sentenceCount} 个已确认的重点句`,
    });
  }

  // 摘要只用来给"读完写一句"的任务提供依据；没有摘要就不排这条
  if (summary && seeds.length === 0) {
    seeds.push({
      module: 'READING',
      targetSkill: 'READING',
      title: '读摘要并复述主旨',
      suggestedMinutes: 15,
      reason: '本材料只有摘要，没有其他已确认内容',
    });
  }

  return seeds;
}

/** 取基准日起 7 天的预算快照。 */
async function loadBudgetDays(baseDate: string): Promise<BudgetDay[]> {
  const dates = listDateRange(baseDate, addDays(baseDate, PROPOSAL_WINDOW_DAYS - 1));
  return Promise.all(
    dates.map(async (date) => {
      const budget = await getEffectiveBudget(date);
      return { date, minutes: budget.minutes, isRestDay: budget.isRestDay };
    }),
  );
}

export interface CreateProposalActionData {
  proposalId: string;
  /** true = 复用已有的 draft（同一天重复调用不堆草案）。 */
  reused: boolean;
  items: number;
  totalMinutes: number;
  overflowDays: number;
  rationale: string;
  /** 基准日预算快照。 */
  budgetMinutes: number;
}

/**
 * 生成任务草案。
 *
 * 同一天重复调用：已有 `draft` 就**返回现有那条**（不重复堆草案），
 * 除非显式 `force: true`（先把旧 draft 置 `discarded`）。
 *
 * @param raw `{ materialId, baseDate, force? }`
 */
export async function createTaskProposalAction(
  raw: unknown,
): Promise<ActionResult<CreateProposalActionData>> {
  const parsed = taskProposalCreateSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, baseDate, force } = parsed.data;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, status: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const status = material.status as MaterialStatus;
  if (!PACKABLE_STATUSES.includes(status)) {
    return fail('PRECONDITION', '材料还在处理中，等分析完成后再生成任务草案');
  }

  const existingDraft = await prisma.taskProposal.findFirst({
    where: { materialId, status: 'draft' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, totalMinutes: true, overflowDays: true, rationale: true, budgetMinutes: true },
  });

  if (existingDraft && force !== true) {
    const itemCount = await prisma.taskProposalItem.count({
      where: { proposalId: existingDraft.id },
    });
    return ok<CreateProposalActionData>({
      proposalId: existingDraft.id,
      reused: true,
      items: itemCount,
      totalMinutes: existingDraft.totalMinutes,
      overflowDays: existingDraft.overflowDays,
      rationale: existingDraft.rationale ?? '',
      budgetMinutes: existingDraft.budgetMinutes,
    });
  }

  const seeds = await buildSeedsFromPack(materialId);
  if (seeds.length === 0) {
    return fail('PRECONDITION', '这份材料还没有可排入的内容（先审核分析结果或生成练习）');
  }

  const days = await loadBudgetDays(baseDate);
  const split: SplitResult = splitProposalAcrossDays(seeds, days, {
    granularity: DEFAULT_PROPOSAL_GRANULARITY,
  });
  if (split.items.length === 0) {
    return fail('PRECONDITION', split.rationale);
  }

  const pack = await prisma.materialPack.findUnique({
    where: { materialId },
    select: { id: true },
  });
  const baseBudget = days.find((day) => day.date === baseDate)?.minutes ?? 0;

  const proposalId = await prisma.$transaction(async (tx) => {
    if (existingDraft && force === true) {
      await tx.taskProposal.update({
        where: { id: existingDraft.id },
        data: { status: 'discarded' },
      });
    }

    const proposal = await tx.taskProposal.create({
      data: {
        materialId,
        packId: pack?.id ?? null,
        baseDate,
        budgetMinutes: baseBudget,
        totalMinutes: split.totalMinutes,
        overflowDays: split.overflowDays,
        status: 'draft',
        rationale: split.rationale,
      },
      select: { id: true },
    });

    await tx.taskProposalItem.createMany({
      data: split.items.map((item) => ({
        proposalId: proposal.id,
        module: item.module,
        targetSkill: item.targetSkill,
        title: item.title,
        suggestedMinutes: item.minutes,
        suggestedDate: item.date,
        granularity: item.granularity,
        reason: item.reason ?? null,
        exerciseIdsJson:
          item.exerciseIds && item.exerciseIds.length > 0
            ? JSON.stringify(item.exerciseIds)
            : null,
        selected: true,
      })),
    });

    return proposal.id;
  });

  revalidatePackPaths(materialId);

  return ok<CreateProposalActionData>({
    proposalId,
    reused: false,
    items: split.items.length,
    totalMinutes: split.totalMinutes,
    overflowDays: split.overflowDays,
    rationale: split.rationale,
    budgetMinutes: baseBudget,
  });
}

// ───────────────────────── ③ 改一条草案条目 ─────────────────────────

export interface UpdateProposalItemData {
  itemId: string;
  selected: boolean;
  finalMinutes: number | null;
  finalDate: string | null;
  effectiveDate: string;
  effectiveMinutes: number;
  /** 改完之后草案整体的超支明细（页面直接渲染）。 */
  violations: { date: string; budgetMinutes: number; allocatedMinutes: number }[];
}

/**
 * 改草案条目（勾选 / 改分钟 / 改日期）。只允许改 `draft` 状态的草案。
 *
 * @param raw `{ itemId, selected?, finalMinutes?, finalDate? }`
 */
export async function updateProposalItemAction(
  raw: unknown,
): Promise<ActionResult<UpdateProposalItemData>> {
  const parsed = proposalItemUpdateSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const item = await prisma.taskProposalItem.findUnique({
    where: { id: parsed.data.itemId },
    select: {
      id: true,
      suggestedMinutes: true,
      suggestedDate: true,
      finalMinutes: true,
      finalDate: true,
      selected: true,
      proposal: { select: { id: true, status: true, materialId: true, baseDate: true } },
    },
  });
  if (!item) return fail('NOT_FOUND', '这条草案不存在，可能已被丢弃');

  if (item.proposal.status !== 'draft') {
    return fail('PRECONDITION', '这份草案已经确认或已丢弃，不能再改');
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.selected !== undefined) data.selected = parsed.data.selected;
  if (parsed.data.finalMinutes !== undefined) data.finalMinutes = parsed.data.finalMinutes;
  if (parsed.data.finalDate !== undefined) {
    if (!isValidDateString(parsed.data.finalDate)) {
      return fail('VALIDATION', '日期格式必须是 YYYY-MM-DD', { finalDate: '日期不合法' });
    }
    data.finalDate = parsed.data.finalDate;
  }
  if (Object.keys(data).length === 0) {
    return fail('VALIDATION', '没有要修改的字段');
  }

  await prisma.taskProposalItem.update({ where: { id: item.id }, data });

  const siblings = await prisma.taskProposalItem.findMany({
    where: { proposalId: item.proposal.id },
    select: { suggestedDate: true, suggestedMinutes: true, finalDate: true, finalMinutes: true },
  });
  const days = await loadBudgetDays(item.proposal.baseDate);
  const check = validateProposalAgainstBudget(
    siblings.map((row) => ({
      date: row.finalDate ?? row.suggestedDate,
      minutes: row.finalMinutes ?? row.suggestedMinutes,
    })),
    days,
  );

  revalidatePackPaths(item.proposal.materialId);

  return ok<UpdateProposalItemData>({
    itemId: item.id,
    selected: parsed.data.selected ?? item.selected,
    finalMinutes: parsed.data.finalMinutes ?? item.finalMinutes,
    finalDate: parsed.data.finalDate ?? item.finalDate,
    effectiveDate:
      parsed.data.finalDate ?? item.finalDate ?? item.suggestedDate,
    effectiveMinutes:
      parsed.data.finalMinutes ?? item.finalMinutes ?? item.suggestedMinutes,
    violations: check.violations,
  });
}

// ───────────────────────── ④ 确认（写 PlanTask，F-03） ─────────────────────────

export interface ConfirmProposalData {
  proposalId: string;
  /** 落地的 PlanTask 数。 */
  created: number;
  /** 失败条目数；原子确认成功后恒为 0。 */
  failed: number;
  status: string;
  totalMinutes: number;
}

type ProposalConflictCode = 'NOT_FOUND' | 'PRECONDITION' | 'VALIDATION' | 'NO_STAGE';

class ProposalConfirmationConflictError extends Error {
  constructor(
    message: string,
    readonly code: ProposalConflictCode,
  ) {
    super(message);
    this.name = 'ProposalConfirmationConflictError';
  }
}

/**
 * 确认草案：只对 `selected === true` 且尚未落地的条目写 PlanTask。
 *
 * 全部条目与草案状态在同一个事务内重新读取；新任务按日批量写入，预算校验与版本审计
 * 只发生在唯一写入者内。任一日预算失败、并发冲突或草案状态变化都会回滚整批。
 *
 * `sourceKind` 经 `mapCandidateSourceToPlanTask('MATERIAL', null) → MANUAL` 映射得到
 * （材料草案是用户勾选落地，语义为"人工决定"）；`priority` 显式取 P1，保持既有排序。
 *
 * @param raw `{ proposalId }`
 */
export async function confirmTaskProposalAction(
  raw: unknown,
): Promise<ActionResult<ConfirmProposalData>> {
  const parsed = taskProposalConfirmSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  let materialId = '';
  try {
    const confirmed = await prisma.$transaction(async (tx) => {
      const proposal = await tx.taskProposal.findUnique({
        where: { id: parsed.data.proposalId },
        select: {
          id: true,
          materialId: true,
          status: true,
          baseDate: true,
          items: {
            orderBy: [{ suggestedDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              module: true,
              targetSkill: true,
              title: true,
              suggestedMinutes: true,
              finalMinutes: true,
              suggestedDate: true,
              finalDate: true,
              selected: true,
              planTaskId: true,
              reason: true,
            },
          },
        },
      });
      if (!proposal) {
        throw new ProposalConfirmationConflictError('这份草案不存在，可能已被丢弃', 'NOT_FOUND');
      }
      materialId = proposal.materialId;
      if (proposal.status !== 'draft') {
        throw new ProposalConfirmationConflictError('这份草案已经确认过了', 'PRECONDITION');
      }

      const selected = proposal.items.filter((item) => item.selected);
      if (selected.length === 0) {
        throw new ProposalConfirmationConflictError('至少要勾选一条草案才能确认', 'VALIDATION');
      }

      const windowEnd = addDays(proposal.baseDate, PROPOSAL_WINDOW_DAYS - 1);
      const outsideWindow = selected.find((item) => {
        const date = item.finalDate ?? item.suggestedDate;
        return date < proposal.baseDate || date > windowEnd;
      });
      if (outsideWindow) {
        const date = outsideWindow.finalDate ?? outsideWindow.suggestedDate;
        throw new ProposalConfirmationConflictError(
          `勾选条目日期 ${date} 超出草案窗口 ${proposal.baseDate} 至 ${windowEnd}`,
          'VALIDATION',
        );
      }

      const stage = await tx.stage.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { sortOrder: 'asc' },
        select: { id: true },
      });
      if (!stage) {
        throw new ProposalConfirmationConflictError(
          '还没有激活的学习阶段，无法写入计划',
          'NO_STAGE',
        );
      }

      const pending = selected.filter((item) => !item.planTaskId);
      const totalMinutes = selected.reduce(
        (sum, item) => sum + (item.finalMinutes ?? item.suggestedMinutes),
        0,
      );

      if (pending.length > 0) {
        await appendTaskBatchInTransaction(
          tx,
          pending.map((item) => {
            const axes = taskAxesOf(item.module as ModuleId, item.targetSkill);
            return {
              stageId: stage.id,
              planDate: item.finalDate ?? item.suggestedDate,
              module: item.module as ModuleId,
              skill: axes.skill,
              plannedMinutes: item.finalMinutes ?? item.suggestedMinutes,
              priority: 'P1' as const,
              sourceKind: mapCandidateSourceToPlanTask('MATERIAL', null),
              track: axes.track,
              primarySkill: axes.primarySkill,
              note: `${item.title}（来自材料任务草案${item.reason ? `：${item.reason}` : ''}）`.slice(0, 300),
              origin: 'MATERIAL_CONFIRM' as const,
              proposalItemId: item.id,
            };
          }),
        );
      }

      const claimed = await tx.taskProposal.updateMany({
        where: { id: proposal.id, status: 'draft' },
        data: { status: 'confirmed', totalMinutes },
      });
      if (claimed.count !== 1) {
        throw new ProposalConfirmationConflictError('这份草案已经确认过了', 'PRECONDITION');
      }

      return {
        proposalId: proposal.id,
        created: pending.length,
        failed: 0,
        status: 'confirmed',
        totalMinutes,
      };
    });

    revalidatePackPaths(materialId);
    return ok<ConfirmProposalData>(confirmed);
  } catch (error) {
    if (error instanceof ProposalConfirmationConflictError) {
      const code = error.code === 'NO_STAGE' ? 'PRECONDITION' : error.code;
      return fail(code, error.message);
    }
    if (error instanceof BudgetGateError) return fail('PRECONDITION', error.message);
    if (
      typeof error === 'object' && error !== null && 'code' in error
      && ['P2002', 'P2028'].includes((error as { code?: unknown }).code as string)
    ) {
      return fail('CONFLICT', '计划写入发生并发冲突，请刷新后重试');
    }
    throw error;
  }
}

// `skillOfModule()` 已收编到 `domain/planWriteMap.ts`（v2.7 T06a），
// 与 `taskAxesOf()` 共用同一份映射；此处直接从 domain 导入，口径逐值不变。

// ───────────────────────── ⑤ 丢弃草案 ─────────────────────────

/**
 * 丢弃草案（`draft → discarded`）。
 *
 * **不碰已写入的 PlanTask**：确认过的内容属于计划表，用户丢的是"还没确认的建议"。
 * 顺手删任务会让"我只想重排一下"变成一次数据丢失。
 *
 * @param raw `{ proposalId }`
 */
export async function discardTaskProposalAction(
  raw: unknown,
): Promise<ActionResult<{ proposalId: string; status: string }>> {
  const parsed = taskProposalDiscardSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const proposal = await prisma.taskProposal.findUnique({
    where: { id: parsed.data.proposalId },
    select: { id: true, materialId: true, status: true },
  });
  if (!proposal) return fail('NOT_FOUND', '这份草案不存在，可能已被丢弃');
  if (proposal.status !== 'draft') {
    return fail('PRECONDITION', '只有待确认的草案可以丢弃');
  }

  await prisma.taskProposal.update({
    where: { id: proposal.id },
    data: { status: 'discarded' },
  });
  revalidatePackPaths(proposal.materialId);

  return ok({ proposalId: proposal.id, status: 'discarded' });
}

// ───────────────────── ⑥ 导出被拦时留痕（R2） ─────────────────────

export interface ExportBlockedData {
  blocked: boolean;
  rule: string;
  note: string;
}

/**
 * 记录一次「导出被拦」。
 *
 * 为什么需要这个 action：权属不明/仅订阅访问的材料**禁止导出**，但"禁止"这件事
 * 必须留痕（R2）。纯前端 `disabled` 是拦不住的（改一下 DOM 就绕过了），
 * 而且"用户点过但被拦了"这个事实在事后复盘时非常有用 —— 它证明系统尽到了提示义务。
 *
 * 注意：按钮在界面上是"禁用态"（灰、不可聚焦）但仍可点 —— 点了就是为了留痕并提示，
 * 而不是真的去导出。真正的导出能力本批不实现。
 *
 * @param raw `{ materialId }`
 */
export async function recordExportBlockedAction(
  raw: unknown,
): Promise<ActionResult<ExportBlockedData>> {
  const idParsed = materialPackBuildSchema.safeParse({ materialId: (raw as { materialId?: unknown })?.materialId });
  if (!idParsed.success) return failValidation(idParsed.error);

  const material = await prisma.learningMaterial.findUnique({
    where: { id: idParsed.data.materialId },
    select: {
      id: true,
      sourceType: true,
      source: { select: { rightsConfirmed: true, licenseName: true } },
    },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const restricted =
    material.sourceType === 'unknown' ||
    material.sourceType === 'licensed_subscription' ||
    material.source?.rightsConfirmed === false;

  if (!restricted) {
    // 不限制的材料：没有拦截记录可写，直接告诉调用方"其实可以导出"
    return ok<ExportBlockedData>({
      blocked: false,
      rule: 'none',
      note: '该材料来源明确，导出未被限制',
    });
  }

  const rule =
    material.source?.rightsConfirmed === false
      ? 'rightsConfirmed=false'
      : `sourceType=${material.sourceType}`;

  await prisma.materialPermissionRecord.create({
    data: {
      materialId: material.id,
      action: 'EXPORT_BLOCKED',
      rule,
      note: material.source?.licenseName
        ? `导出被拦（许可证：${material.source.licenseName}）`
        : '导出被拦：来源权属未确认',
    },
  });

  revalidatePath(`/materials/${material.id}/source`);

  return ok<ExportBlockedData>({
    blocked: true,
    rule,
    note: '已记录这次导出请求。来源权属明确之前，原文不允许导出。',
  });
}
