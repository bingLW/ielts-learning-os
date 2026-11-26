/**
 * 材料包 + 任务草案的集成测试（T13）。
 *
 * 覆盖的硬要求（§7）：
 * - **AC-06 只聚合引用**：`MaterialPackItem` 里任何字符串字段都不得包含原文片段；
 * - **重复建包幂等**：不 rebuild 时包与条目 id 都不变，rebuild 时条目数量不变；
 * - **F-03 草案 ≠ 计划**：`draft` 状态下 `planTask.count()` 不变，确认后只对
 *   `selected` 的条目建任务，且回写 `planTaskId`；
 * - **超预算确认被拒**：`PRECONDITION` + `planTask.count()` 不变 + 草案仍是 draft；
 * - **引用失效**：被引用的练习集删掉后包仍可查询，该条解析为「内容已移除」。
 *
 * 每个用例使用独立临时库和自己的材料（标题唯一，靠内容哈希去重不会撞）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();

const { finalizeMaterialUpload } = await import('@/lib/materials/upload');
const { runPipelineTick } = await import('@/lib/materials/pipeline');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
const { bulkReviewExtractionAction } = await import('@/lib/actions/materialAnalysis');
const { bulkAcceptVocabularyCandidatesAction } = await import(
  '@/lib/actions/materialVocabulary'
);
const {
  buildMaterialPackAction,
  confirmTaskProposalAction,
  createTaskProposalAction,
  discardTaskProposalAction,
  updateProposalItemAction,
} = await import('@/lib/actions/materialPack');
const { getMaterialPack, getTaskProposal } = await import('@/lib/queries/materials');
const { PACK_ITEM_TYPES } = await import('@/lib/services/materialPackRepo');
const { addDays } = await import('@/lib/date');

/**
 * 单行样本文本。
 *
 * 硬约束（T12 踩过的坑）：mock 的引用取自第一句，且 `excerpt()` 在第一个
 * `.`/换行处截断 —— 标题必须与正文同一行，第一句要 ≥ 8 字符，
 * 否则 `verifySourceQuote` 会因"太短"把整条 KEYWORD 丢掉。
 */
function sampleText(title: string): string {
  return (
    `${title} is a sample passage for material pack testing. `
    + 'Reading improves with deliberate practice and steady attention every day. '
    + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge does.'
  );
}

interface PasteMeta {
  title: string;
  pastedText: string;
  source: { sourceType: string; rightsConfirmed: boolean };
}

function pasteForm(title: string): FormData {
  const formData = new FormData();
  const meta: PasteMeta = {
    title,
    pastedText: sampleText(title),
    source: { sourceType: 'user_upload', rightsConfirmed: true },
  };
  formData.set('meta', JSON.stringify(meta));
  return formData;
}

const createdMaterialIds = new Set<string>();

async function importText(title: string): Promise<string> {
  const result = await finalizeMaterialUpload(pasteForm(title));
  if (!result.ok) throw new Error(`导入失败：${result.error}`);
  if (result.data.duplicateOf) throw new Error(`用例隔离被破坏：${title} 命中去重`);
  createdMaterialIds.add(result.data.materialId);
  return result.data.materialId;
}

/** 跑到待审核（或任意终态）。 */
async function settle(materialId: string): Promise<void> {
  await runPipelineTick(materialId);
  for (let index = 0; index < 12; index += 1) {
    const row = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true },
    });
    if (['review_required', 'partial', 'failed', 'cancelled', 'ready'].includes(row?.status ?? '')) {
      return;
    }
    await runPipelineTick(materialId);
  }
}

/** 把所有抽取结果一次性「已采纳」（含 SUMMARY / KEY_SENTENCE）。 */
async function acceptAllExtractions(materialId: string): Promise<void> {
  const rows = await prisma.extractionResult.findMany({
    where: { materialId, reviewStatus: 'draft' },
    select: { id: true },
  });
  if (rows.length === 0) return;
  const result = await bulkReviewExtractionAction({
    materialId,
    ids: rows.map((row) => row.id),
    reviewStatus: 'accepted',
  });
  if (!result.ok) throw new Error(`批量采纳失败：${result.error}`);

  // 采纳关键词会物化出 draft 词汇候选 → 未审完候选会挡住后续流程，这里一并采纳
  const candidates = await prisma.vocabularyCandidate.findMany({
    where: { materialId, reviewStatus: 'draft' },
    select: { id: true },
  });
  if (candidates.length > 0) {
    await bulkAcceptVocabularyCandidatesAction({
      materialId,
      ids: candidates.map((row) => row.id),
    });
  }
}

const BASE_DATE = '2025-10-24';

/** 给基准日起 7 天写死预算（并清掉休息日），让拆分结果可预测。 */
async function seedBudgets(minutes = 60, startDate = BASE_DATE): Promise<void> {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(startDate, offset);
    await prisma.dailyBudget.upsert({
      where: { date },
      create: {
        date,
        plannedAvailableMinutes: minutes,
        isRestDay: false,
        tierCode: null,
        budgetType: 'PRESET',
        source: 'MANUAL',
        isInitialSuggestion: false,
      },
      update: {
        plannedAvailableMinutes: minutes,
        isRestDay: false,
        isInitialSuggestion: false,
      },
    });
  }
}

/** 确保有 ACTIVE 阶段（`createPlanTaskAction` 需要 `stageId`）。 */
async function ensureActiveStage(): Promise<void> {
  const stage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  if (stage) return;
  await prisma.stage.create({
    data: {
      code: 'S3_B1_IELTS',
      nameZh: 'B1→IELTS 过渡',
      estDaysMin: 30,
      status: 'ACTIVE',
      sortOrder: 0,
    },
  });
}

beforeAll(async () => {
  // 提示词注册表必须先用**本测试的** prisma 实例填充（否则 pipeline 拿不到模板）
  await ensurePromptRegistry(prisma);
  await prisma.aIEngineSetting.create({ data: { id: 'default', externalAiEnabled: false } });
  await prisma.aIEngineSetting.updateMany({ data: { externalAiEnabled: false } });
  await seedBudgets(60);
  await ensureActiveStage();
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
  void createdMaterialIds;
});

describe('AC-06：材料包只聚合引用，不复制内容', () => {
  it('包条目只有 refId/itemType/sortOrder/estimatedMinutes/note，且不含任何原文片段', async () => {
    const materialId = await importText('包引用样本A');
    await settle(materialId);
    await acceptAllExtractions(materialId);

    const built = await buildMaterialPackAction({ materialId });
    expect(built.ok).toBe(true);

    const chunkTexts = (
      await prisma.contentChunk.findMany({
        where: { materialId },
        select: { text: true },
      })
    ).map((row) => row.text);
    expect(chunkTexts.length).toBeGreaterThan(0);

    const pack = await prisma.materialPack.findUnique({ where: { materialId } });
    expect(pack).not.toBeNull();
    const items = await prisma.materialPackItem.findMany({
      where: { packId: pack?.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      // 类型必须是已知枚举（防止拼错的 itemType 悄悄进库）
      expect(PACK_ITEM_TYPES).toContain(item.itemType);
      // 所有字符串字段都必须是"短的引用描述"，不是正文
      for (const value of Object.values(item)) {
        if (typeof value !== 'string') continue;
        expect(value.length).toBeLessThan(200);
        for (const text of chunkTexts) {
          expect(text.includes(value)).toBe(false);
        }
      }
    }

    // 条目里必须真的有 refId 指向别的表（不是把内容抄进来）
    expect(items.every((item) => item.refId.length > 0)).toBe(true);
    // 包表本身也不存正文：学习目标/技能都是短 JSON
    expect((pack?.learningGoalsJson ?? '').length).toBeLessThan(2000);
  });

  it('重复建包幂等：不 rebuild 时 packId 与条目 id 都不变；rebuild 时条目数量不变', async () => {
    const materialId = await importText('包引用样本B');
    await settle(materialId);
    await acceptAllExtractions(materialId);

    const first = await buildMaterialPackAction({ materialId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = await prisma.materialPackItem.findMany({
      where: { packId: first.data.packId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, itemType: true, refId: true },
    });

    const again = await buildMaterialPackAction({ materialId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.rebuilt).toBe(false);
    expect(again.data.packId).toBe(first.data.packId);
    const same = await prisma.materialPackItem.findMany({
      where: { packId: first.data.packId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, itemType: true, refId: true },
    });
    expect(same).toEqual(before);

    const rebuilt = await buildMaterialPackAction({ materialId, rebuild: true });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.data.rebuilt).toBe(true);
    expect(rebuilt.data.packId).toBe(first.data.packId);
    expect(rebuilt.data.itemCount).toBe(before.length);
    expect(await prisma.materialPackItem.count({ where: { packId: first.data.packId } })).toBe(
      before.length,
    );
  });
});

describe('F-03：草案阶段的勾选才会写进计划', () => {
  it('draft 状态下 planTask 数量不变；确认后只对 selected 条目建任务并回写 planTaskId', async () => {
    const materialId = await importText('草案样本A');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const planTaskBefore = await prisma.planTask.count();
    const created = await createTaskProposalAction({ materialId, baseDate: BASE_DATE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.items).toBeGreaterThan(0);

    // 草案只是建议：一条 PlanTask 都不该出现
    expect(await prisma.planTask.count()).toBe(planTaskBefore);

    const proposal = await getTaskProposal(materialId);
    expect(proposal).not.toBeNull();
    if (!proposal) return;
    expect(proposal.status).toBe('draft');
    expect(proposal.items.length).toBe(created.data.items);

    // 取消勾选最后一条
    const dropped = proposal.items[proposal.items.length - 1];
    const updated = await updateProposalItemAction({ itemId: dropped.id, selected: false });
    expect(updated.ok).toBe(true);

    const selectedCount = proposal.items.length - 1;
    const confirmed = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.created).toBe(selectedCount);
    expect(confirmed.data.status).toBe('confirmed');
    expect(await prisma.planTask.count()).toBe(planTaskBefore + selectedCount);

    // 每一条 selected 的都回写了 planTaskId；没勾的那条没有
    const rows = await prisma.taskProposalItem.findMany({
      where: { proposalId: proposal.id },
      select: { id: true, selected: true, planTaskId: true },
    });
    for (const row of rows) {
      if (row.selected) expect(row.planTaskId).not.toBeNull();
      else expect(row.planTaskId).toBeNull();
    }

    // 确认后草案不能重复确认
    const twice = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.code).toBe('PRECONDITION');
  });

  it('丢弃草案不碰已经写入的 PlanTask', async () => {
    const materialId = await importText('草案样本B');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const created = await createTaskProposalAction({ materialId, baseDate: BASE_DATE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const planTaskBefore = await prisma.planTask.count();
    const discarded = await discardTaskProposalAction({ proposalId: created.data.proposalId });
    expect(discarded.ok).toBe(true);
    expect(await prisma.planTask.count()).toBe(planTaskBefore);

    const row = await prisma.taskProposal.findUnique({
      where: { id: created.data.proposalId },
      select: { status: true },
    });
    expect(row?.status).toBe('discarded');
  });
});

describe('超预算确认被拒（PRECONDITION）', () => {
  it('把一条改成 240 分钟 → 确认返回 PRECONDITION，planTask 不变，草案仍 draft', async () => {
    const materialId = await importText('超预算样本');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const created = await createTaskProposalAction({ materialId, baseDate: BASE_DATE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const proposal = await getTaskProposal(materialId);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    const target = proposal.items[0];
    const updated = await updateProposalItemAction({ itemId: target.id, finalMinutes: 240 });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // 当日预算 60 分钟，240 一定超支
    expect(updated.data.violations.length).toBeGreaterThan(0);
    expect(updated.data.violations[0].date).toBe(target.effectiveDate);

    const planTaskBefore = await prisma.planTask.count();
    const confirmed = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.code).toBe('PRECONDITION');
    expect(confirmed.error).toContain('超出每日预算');
    expect(await prisma.planTask.count()).toBe(planTaskBefore);

    const row = await prisma.taskProposal.findUnique({
      where: { id: proposal.id },
      select: { status: true },
    });
    expect(row?.status).toBe('draft');
  });
});

async function activeStageId(): Promise<string> {
  const stage = await prisma.stage.findFirstOrThrow({ where: { status: 'ACTIVE' } });
  return stage.id;
}

describe('材料确认原子性与预算边界', () => {
  it('已有 PlanTask 占用计入预算：材料条目超支时整批不写、草案仍 draft', async () => {
    const baseDate = '2025-11-01';
    await seedBudgets(60, baseDate);
    const materialId = await importText('已有占用样本');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const created = await createTaskProposalAction({ materialId, baseDate });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const proposal = await getTaskProposal(materialId);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    await prisma.taskProposalItem.updateMany({
      where: { proposalId: proposal.id, id: { not: proposal.items[0].id } },
      data: { selected: false },
    });
    const existing = await prisma.planTask.create({
      data: {
        stageId: await activeStageId(),
        planDate: baseDate,
        module: 'READING',
        skill: 'READING',
        plannedMinutes: 45,
        status: 'TODO',
        sourceKind: 'MANUAL',
        track: 'IELTS_PREPARATION',
        primarySkill: 'READING',
      },
    });
    const updated = await updateProposalItemAction({
      itemId: proposal.items[0].id,
      finalMinutes: 30,
    });
    expect(updated.ok).toBe(true);

    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();
    const result = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.error).toContain('超出每日预算');
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect((await prisma.taskProposal.findUnique({ where: { id: proposal.id } }))?.status).toBe('draft');
    expect((await prisma.planTask.findUnique({ where: { id: existing.id } }))?.plannedMinutes).toBe(45);
  });

  it('窗口外条目直接拒绝：VALIDATION，零 PlanTask、零版本、草案仍 draft', async () => {
    const baseDate = '2025-11-02';
    await seedBudgets(60, baseDate);
    const materialId = await importText('窗口边界样本');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const created = await createTaskProposalAction({ materialId, baseDate });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const proposal = await getTaskProposal(materialId);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    const outsideDate = addDays(baseDate, 7);
    await prisma.taskProposalItem.update({
      where: { id: proposal.items[0].id },
      data: { finalDate: outsideDate },
    });
    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();
    const result = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION');
    expect(result.error).toContain(outsideDate);
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect((await prisma.taskProposal.findUnique({ where: { id: proposal.id } }))?.status).toBe('draft');
  });

  it('多日期任一日超支整批回滚；预算恢复后确认，每日恰有一个 MANUAL_ADJUST 版本', async () => {
    const baseDate = '2025-11-03';
    await seedBudgets(60, baseDate);
    const materialId = await importText('多日原子样本');
    await settle(materialId);
    await acceptAllExtractions(materialId);
    await buildMaterialPackAction({ materialId });

    const created = await createTaskProposalAction({ materialId, baseDate });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const proposal = await getTaskProposal(materialId);
    expect(proposal).not.toBeNull();
    if (!proposal || proposal.items.length < 2) return;
    const [first, second] = proposal.items;
    const secondDate = addDays(baseDate, 1);

    await prisma.taskProposalItem.updateMany({
      where: { proposalId: proposal.id, id: { notIn: [first.id, second.id] } },
      data: { selected: false },
    });
    await updateProposalItemAction({
      itemId: first.id,
      selected: true,
      finalDate: baseDate,
      finalMinutes: 30,
    });
    await updateProposalItemAction({
      itemId: second.id,
      selected: true,
      finalDate: secondDate,
      finalMinutes: 30,
    });
    await prisma.dailyBudget.update({
      where: { date: secondDate },
      data: { plannedAvailableMinutes: 10 },
    });

    const tasksBefore = await prisma.planTask.count();
    const versionsBefore = await prisma.planVersion.count();
    const rejected = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('PRECONDITION');
    expect(await prisma.planTask.count()).toBe(tasksBefore);
    expect(await prisma.planVersion.count()).toBe(versionsBefore);
    expect(await prisma.taskProposalItem.count({
      where: { proposalId: proposal.id, planTaskId: { not: null } },
    })).toBe(0);
    expect((await prisma.taskProposal.findUnique({ where: { id: proposal.id } }))?.status).toBe('draft');

    await prisma.dailyBudget.update({
      where: { date: secondDate },
      data: { plannedAvailableMinutes: 60 },
    });
    const accepted = await confirmTaskProposalAction({ proposalId: proposal.id });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.data.created).toBe(2);
    expect(accepted.data.failed).toBe(0);

    for (const date of [baseDate, secondDate]) {
      const versions = await prisma.planVersion.findMany({
        where: { planDate: date, reason: '材料草案确认写入计划' },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0].changeSource).toBe('MANUAL_ADJUST');
    }
  });
});

describe('引用失效：被引用对象删掉后包仍可查询', () => {
  it('练习集被删 → 该条解析为「内容已移除」，refId 仍保留', async () => {
    const materialId = await importText('引用失效样本');
    await settle(materialId);
    await acceptAllExtractions(materialId);

    const set = await prisma.materialExerciseSet.create({
      data: {
        materialId,
        title: '待删除的练习集',
        targetSkill: 'READING',
        estimatedMinutes: 15,
        isActive: true,
      },
      select: { id: true },
    });

    const built = await buildMaterialPackAction({ materialId });
    expect(built.ok).toBe(true);

    const beforePack = await getMaterialPack(materialId);
    expect(beforePack).not.toBeNull();
    const setItemBefore = beforePack?.items.find((item) => item.itemType === 'EXERCISE_SET');
    expect(setItemBefore?.missing).toBe(false);
    expect(setItemBefore?.refId).toBe(set.id);

    await prisma.materialExerciseSet.delete({ where: { id: set.id } });

    const afterPack = await getMaterialPack(materialId);
    expect(afterPack).not.toBeNull();
    const setItemAfter = afterPack?.items.find((item) => item.itemType === 'EXERCISE_SET');
    // 条目还在（弱引用不删），但解析不到对象
    expect(setItemAfter).toBeDefined();
    expect(setItemAfter?.missing).toBe(true);
    expect(setItemAfter?.refId).toBe(set.id);
    expect(setItemAfter?.href).toBeNull();
  });
});
