/**
 * 处理管线集成测试（真实 Prisma，独立临时数据库）。
 *
 * `next/cache` 的 `revalidatePath` 需要 Next 请求上下文，这里显式 mock 掉，
 * 其余逻辑（落盘、去重、状态机、tick、取消、重试、删除预览）全部走真实实现。
 *
 * 覆盖 T08 验收清单：
 * - 状态机合法/非法转移（DB 层面：只有 failed 能重试、终态不能再推进）
 * - 取消收敛（cancelRequested → cancelled，两个表同时落定）
 * - 重试复用分块、跳过 extracting
 * - lockVersion 乐观锁冲突
 * - hash 去重返回 duplicateOf（不新建记录）
 * - getDeletionPreview 计数 / getMaterialImportContext 限额
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();

const { finalizeMaterialUpload } = await import('@/lib/materials/upload');
const { runPipelineTick } = await import('@/lib/materials/pipeline');
const { materialsDir } = await import('@/lib/storage');
const actions = await import('@/lib/actions/materials');
const queries = await import('@/lib/queries/materials');
const { MATERIAL_LIMITS } = await import('@/lib/constants');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');
// T11 起 `generating` 是真实生成器：此时分析结果还全是 draft，生成器会带着
// "没有出题依据"的原因回到 review_required（而不是写一句占位文案）。
const { GENERATING_NO_ANCHOR_REASON } = await import(
  '@/lib/materials/pipeline/stages/generating'
);

/**
 * T09 之后 tick 会跑到 `analyzing`，而它要走真实的 `runAiCompletion`：
 * 必须先把材料域提示词发布出来（幂等），并强制 mock 通道，绝不打真实模型。
 */
beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  await prisma.aIEngineSetting.create({ data: { id: 'default', externalAiEnabled: false } });
  await prisma.aIEngineSetting.updateMany({ data: { externalAiEnabled: false } });
});

/** 本次测试创建的材料 id（afterAll 清理磁盘目录）。 */
const createdIds = new Set<string>();

const TEXT =
  'Reading is a skill that improves with deliberate practice. '
  + 'It also depends on how much vocabulary you already control. '
  + 'Vocabulary breadth predicts comprehension more strongly than grammar knowledge. '
  + 'Therefore learners should read widely and review what they meet.';

/**
 * 每个用例的正文都必须互不相同。
 *
 * `finalizeMaterialUpload` 会按 `contentHash` 去重（A-04），若所有样本共用同一段
 * `TEXT`，第二个 `importText()` 起都会**命中第一个材料**返回同一个 id —— 用例之间
 * 会互相污染，且失败信息会指向完全无关的断言。这里把标题混进正文，既保持文本结构
 * 一致（照样能分块），又保证每个样本独立。
 */
function textFor(title: string): string {
  return `${title}：${TEXT}`;
}

function pasteForm(title: string, text: string): FormData {
  const formData = new FormData();
  formData.set(
    'meta',
    JSON.stringify({
      title,
      pastedText: text,
      source: { sourceType: 'user_upload', rightsConfirmed: true },
    }),
  );
  return formData;
}

/** 用粘贴通道导入一份文本材料（走真实落盘 + 真实事务）。 */
async function importText(title: string, text = textFor(title)): Promise<string> {
  const result = await finalizeMaterialUpload(pasteForm(title, text));
  if (!result.ok) throw new Error(`导入失败：${result.error}`);
  if (result.data.duplicateOf) {
    throw new Error(`用例隔离被破坏：${title} 命中了去重（${result.data.duplicateOf}）`);
  }
  createdIds.add(result.data.materialId);
  return result.data.materialId;
}

async function tick(materialId: string) {
  const result = await runPipelineTick(materialId);
  if (!result.ok) throw new Error(`tick 失败：${result.error}`);
  return result.data;
}

/** 连续 tick 直到进入非处理中状态（最多 6 次，防止死循环）。 */
async function runToEnd(materialId: string) {
  let last = await tick(materialId);
  for (let index = 0; index < 5 && last.reason === 'advanced'; index += 1) {
    const status = (await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true },
    }))?.status;
    if (status === 'review_required' || status === 'partial' || status === 'failed') break;
    last = await tick(materialId);
  }
  return last;
}

/**
 * 结束时是否清理材料原文目录；临时数据库始终由 createTestDb 清理。
 *
 * 默认开；但在「删除被安全钩子拦一层」的机器上，每次 unlink 会同步阻塞约 2s，
 * 二十来个样本就会把 hook 拖出 10s 默认超时、把一份全绿的用例判成失败。
 * 这种环境用 `MATERIALS_TEST_CLEANUP=0 npm test` 跳过目录清理。hook 超时放宽到 60s。
 */
const CLEANUP_ARTIFACTS = process.env.MATERIALS_TEST_CLEANUP !== '0';

afterAll(async () => {
  if (CLEANUP_ARTIFACTS) {
    // 失败一律忽略：清理是收尾动作，绝不能因为它把整份用例判红
    await Promise.allSettled(Array.from(createdIds, (id) => removeMaterialDir(id)));
  }
  await prisma.$disconnect();
  cleanup();
}, 60_000);

/** 异步删除材料原文目录（失败忽略）。 */
async function removeMaterialDir(materialId: string): Promise<void> {
  try {
    await rm(join(materialsDir(), materialId), { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

describe('导入与去重（A-04）', () => {
  it('同内容第二次导入返回 duplicateOf 且不新建记录', async () => {
    const firstId = await importText('去重样本 A');
    const before = await prisma.learningMaterial.count();

    // 正文与第一次完全一致 → 命中 contentHash 去重
    const second = await finalizeMaterialUpload(pasteForm('去重样本 A', textFor('去重样本 A')));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.duplicateOf).toBe(firstId);
    expect(second.data.materialId).toBe(firstId);
    expect(await prisma.learningMaterial.count()).toBe(before);
  });

  it('另存为副本：新建一条记录并指向原材料，不复制 chunk', async () => {
    const originId = await importText('副本样本');
    const clone = await actions.confirmDuplicateChoiceAction({
      materialId: originId,
      choice: 'keep_copy',
    });
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    createdIds.add(clone.data.materialId);

    expect(clone.data.created).toBe(true);
    expect(clone.data.materialId).not.toBe(originId);

    const copy = await prisma.learningMaterial.findUnique({
      where: { id: clone.data.materialId },
      select: { duplicateOfId: true, status: true, contentHash: true },
    });
    expect(copy?.duplicateOfId).toBe(originId);
    expect(copy?.status).toBe('created');
    expect(await prisma.contentChunk.count({ where: { materialId: clone.data.materialId } })).toBe(0);
    expect(await prisma.materialAsset.count({ where: { materialId: clone.data.materialId } })).toBe(1);
  });

  it('open_existing 直接返回已有材料且不新建', async () => {
    const originId = await importText('打开已有样本');
    const before = await prisma.learningMaterial.count();
    const result = await actions.confirmDuplicateChoiceAction({
      materialId: originId,
      choice: 'open_existing',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ materialId: originId, created: false });
    expect(await prisma.learningMaterial.count()).toBe(before);
  });
});

describe('tick 引擎：四阶段推进到 review_required', () => {
  it('validating → extracting → normalizing → analyzing → review_required，并落 chunk', async () => {
    const materialId = await importText('管线样本');

    const first = await tick(materialId);
    expect(first.advanced).toBe(true);
    expect(first.status).toBe('extracting');

    const second = await tick(materialId);
    expect(second.status).toBe('normalizing');

    const third = await tick(materialId);
    // normalizing 完成后进入 analyzing（T09 已注册该阶段）
    expect(third.status).toBe('analyzing');
    expect(third.advanced).toBe(true);

    // analyzing 跑完批次 + 摘要后进入 generating（T11 真实生成器）→ review_required
    const last = await runToEnd(materialId);
    expect(last.status).toBe('review_required');
    expect(last.reason).toBe('advanced');

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: {
        status: true,
        statusReason: true,
        charCount: true,
        wordCount: true,
        chunkCount: true,
        estimatedMinutes: true,
      },
    });
    expect(material?.status).toBe('review_required');
    expect(material?.statusReason).toBe(GENERATING_NO_ANCHOR_REASON);
    expect(material?.charCount).toBeGreaterThan(0);
    expect(material?.wordCount).toBeGreaterThan(0);
    expect(material?.chunkCount).toBeGreaterThan(0);
    expect(material?.estimatedMinutes).toBeGreaterThanOrEqual(5);

    const chunks = await prisma.contentChunk.count({ where: { materialId } });
    expect(chunks).toBe(material?.chunkCount);

    const document = await prisma.parsedDocument.findFirst({
      where: { materialId, isCurrent: true },
      select: { version: true, parserVersion: true, status: true, textChecksum: true },
    });
    expect(document?.version).toBe(1);
    expect(document?.parserVersion).toBe('txt-1');
    expect(document?.status).toBe('OK');
    expect(document?.textChecksum).toHaveLength(64);

    // 进度快照（msByStage）供处理时间线使用
    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: { startedAt: 'desc' },
      select: { stage: true, status: true, progressJson: true, lockVersion: true, aiCallCount: true },
    });
    expect(job?.stage).toBe('generating');
    // 真实生成器走完后 job 正常收尾
    expect(job?.status).toBe('succeeded');
    expect(job?.lockVersion).toBeGreaterThanOrEqual(4);
    expect(job?.aiCallCount).toBeGreaterThanOrEqual(2);
    const progress = JSON.parse(job?.progressJson ?? '{}') as {
      msByStage?: Record<string, number>;
      unitLabel?: string;
      total?: number;
    };
    expect(Object.keys(progress.msByStage ?? {}).sort()).toEqual(
      ['analyzing', 'extracting', 'generating', 'normalizing', 'validating'].sort(),
    );
    // 单位标签由真实生成器写入（一批 chunk 一批题），不再是占位文案
    expect(progress.unitLabel).toBe('批次');
    // 没人采纳过分析结果 → 一批都没跑，进度是 0/0（原因写在 statusReason 里）
    expect(progress.total).toBe(0);

    // 待审核是停靠站：tick 不再跑阶段处理器（不重复花钱、不重复写库）
    const after = await tick(materialId);
    expect(after.advanced).toBe(false);
    expect(after.reason).toBe('awaiting_review');
  });

  it('getMaterialStatus 返回可用的 DTO（阶段/进度/可取消性）', async () => {
    const materialId = await importText('DTO 样本');
    await runToEnd(materialId);

    const dto = await queries.getMaterialStatus(materialId);
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.status).toBe('review_required');
    expect(dto.polling).toBe(false);
    expect(dto.cancellable).toBe(false);
    expect(dto.retryable).toBe(false);
    expect(dto.stages).toHaveLength(5);
    expect(dto.stages.filter((stage) => stage.status === 'done').length).toBeGreaterThanOrEqual(3);
    // 进度单位必须始终可读；`total` 允许为 0 —— 这次没有出题依据，
    // 生成器一批都没跑（原因见 statusReason），界面显示「批次 0 / 0」而不是 NaN。
    expect(dto.progress.unitLabel.length).toBeGreaterThan(0);
    expect(dto.progress.total).toBeGreaterThanOrEqual(0);
    expect(dto.progress.done).toBeLessThanOrEqual(dto.progress.total);
    expect(dto.formatLabel).toBe('粘贴摘录');
  });
});

describe('取消收敛（A-07）', () => {
  it('cancelRequested 后下一次 tick 把两个表都置 cancelled', async () => {
    const materialId = await importText('取消样本');
    await tick(materialId); // created → extracting，任务处于 running

    const cancel = await actions.cancelMaterialJobAction({ materialId });
    expect(cancel.ok).toBe(true);
    if (cancel.ok) expect(cancel.data.status).toBe('extracting');

    const flagged = await prisma.processingJob.findFirst({
      where: { materialId },
      select: { cancelRequested: true },
    });
    expect(flagged?.cancelRequested).toBe(true);

    const converged = await tick(materialId);
    expect(converged.status).toBe('cancelled');
    expect(converged.reason).toBe('cancelled');

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true, statusReason: true },
    });
    expect(material?.status).toBe('cancelled');

    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: { startedAt: 'desc' },
      select: { status: true, finishedAt: true, errorCode: true },
    });
    expect(job?.status).toBe('cancelled');
    expect(job?.errorCode).toBe('CANCELLED');
    expect(job?.finishedAt).not.toBeNull();

    // 终态后 tick 不再推进，取消也不会重复写
    const after = await tick(materialId);
    expect(after.advanced).toBe(false);
    expect(after.reason).toBe('terminal');
  });

  it('终态材料调用取消直接返回当前状态（不写库）', async () => {
    const materialId = await importText('终态取消样本');
    await runToEnd(materialId);
    const result = await actions.cancelMaterialJobAction({ materialId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('review_required');
  });
});

describe('重试（A-08）', () => {
  it('已有解析结果时从 normalizing 续跑，跳过 extracting', async () => {
    const materialId = await importText('重试样本');
    await runToEnd(materialId);

    const documentCountBefore = await prisma.parsedDocument.count({ where: { materialId } });

    // 模拟「后续阶段失败」（T09 才会发生，这里直接置 failed）
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'failed', statusReason: '模拟失败' },
    });

    const retry = await actions.retryMaterialJobAction({ materialId });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.fromStage).toBe('normalizing');
    expect(retry.data.attempt).toBe(2);

    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true, statusReason: true },
    });
    expect(material?.status).toBe('created');
    expect(material?.statusReason).toBeNull();

    // 新 job 取代旧 job
    const jobs = await prisma.processingJob.findMany({
      where: { materialId },
      orderBy: { startedAt: 'asc' },
      select: { id: true, status: true, stage: true, attempt: true, progressJson: true },
    });
    expect(jobs).toHaveLength(2);
    // 这条用例是**人为**把材料置 failed（job 其实是正常收尾的 succeeded）；
    // 真实失败时 job 本来就是 failed，`retryMaterialJobAction` 只负责收尾 running 的那些。
    expect(jobs[0].status).toBe('succeeded');
    expect(jobs[1].attempt).toBe(2);
    expect(jobs[1].stage).toBe('normalizing');

    // 续跑的第一跳：只跑 normalizing（analysing 由后续 tick 继续）
    const after = await tick(materialId);
    expect(after.status).toBe('analyzing');

    // 跳过 extracting：新 job 的耗时表里没有 extracting
    const updated = await prisma.processingJob.findUnique({
      where: { id: retry.data.jobId },
      select: { progressJson: true, stage: true },
    });
    const msByStage = (JSON.parse(updated?.progressJson ?? '{}') as {
      msByStage?: Record<string, number>;
    }).msByStage ?? {};
    expect(Object.keys(msByStage)).toEqual(['normalizing']);
    expect(updated?.stage).toBe('analyzing');

    // 重新分块会写新版本 ParsedDocument（旧版本保留可追溯）
    expect(await prisma.parsedDocument.count({ where: { materialId } })).toBe(documentCountBefore + 1);

    // 继续跑完 analyzing，最终仍停在 review_required
    const last = await runToEnd(materialId);
    expect(last.status).toBe('review_required');
    const finished = await prisma.processingJob.findUnique({
      where: { id: retry.data.jobId },
      select: { stage: true, progressJson: true },
    });
    expect(finished?.stage).toBe('generating');
    // 全程没有回退去重跑 extracting
    const totalMs = (JSON.parse(finished?.progressJson ?? '{}') as {
      msByStage?: Record<string, number>;
    }).msByStage ?? {};
    expect(Object.keys(totalMs).sort()).toEqual(['analyzing', 'generating', 'normalizing']);
  });

  it('非 failed 材料不许重试（非法转移被拦在 action 层）', async () => {
    const materialId = await importText('不可重试样本');
    await tick(materialId);
    const result = await actions.retryMaterialJobAction({ materialId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
  });
});

describe('lockVersion 乐观锁（ADR-05）', () => {
  it('陈旧 lockVersion 的更新匹配 0 行（并发冲突被吞掉）', async () => {
    const materialId = await importText('锁样本');
    await tick(materialId);

    const job = await prisma.processingJob.findFirst({
      where: { materialId },
      orderBy: { startedAt: 'desc' },
      select: { id: true, lockVersion: true },
    });
    expect(job).not.toBeNull();
    if (!job) return;

    const stale = await prisma.processingJob.updateMany({
      where: { id: job.id, lockVersion: job.lockVersion - 1 },
      data: { status: 'failed' },
    });
    expect(stale.count).toBe(0);

    const fresh = await prisma.processingJob.updateMany({
      where: { id: job.id, lockVersion: job.lockVersion },
      data: { lastTickAt: new Date() },
    });
    expect(fresh.count).toBe(1);
  });

  it('并发 tick 只有一个真正推进（另一个不报错）', async () => {
    const materialId = await importText('并发样本');
    const [a, b] = await Promise.all([runPipelineTick(materialId), runPipelineTick(materialId)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const advanced = [a.data, b.data].filter((item) => item.advanced);
    expect(advanced).toHaveLength(1);
    const blocked = [a.data, b.data].filter((item) => !item.advanced);
    expect(['lock_conflict', 'illegal_transition']).toContain(blocked[0].reason);

    // 只前进一步，没有越过阶段
    const material = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
      select: { status: true },
    });
    expect(material?.status).toBe('extracting');
  });
});

describe('查询：删除预览与导入上下文', () => {
  it('getDeletionPreview 统计派生行与保留项', async () => {
    const materialId = await importText('删除预览样本');
    await runToEnd(materialId);

    const preview = await queries.getDeletionPreview(materialId);
    expect(preview.title).toBe('删除预览样本');
    // 至少含：1 材料 + 1 来源 + 1 权限 + 1 资产 + 1 任务 + 1 解析版本 + 每个 chunk
    const chunkCount = await prisma.contentChunk.count({ where: { materialId } });
    expect(preview.deleteRows).toBeGreaterThanOrEqual(6 + chunkCount);
    expect(preview.keepVocabulary).toBe(0);
    expect(preview.keepPlanTasks).toBe(0);
    expect(preview.keepAttempts).toBe(0);
    expect(preview.fileSizeBytes).toBeGreaterThan(0);

    // 不存在的材料返回全 0（不抛错）
    const missing = await queries.getDeletionPreview('cmissinguuid0000000000');
    expect(missing.deleteRows).toBe(0);
  });

  it('删除后派生行清空、主行消失、原文目录删除', async () => {
    const materialId = await importText('真删样本');
    await runToEnd(materialId);

    const result = await actions.deleteMaterialAction({ materialId, confirmText: 'DELETE' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deletedRows).toBeGreaterThan(0);

    expect(await prisma.learningMaterial.count({ where: { id: materialId } })).toBe(0);
    expect(await prisma.contentChunk.count({ where: { materialId } })).toBe(0);
    expect(await prisma.materialAsset.count({ where: { materialId } })).toBe(0);
    createdIds.delete(materialId);
  });

  it('confirmText 不是 DELETE 时拒绝删除', async () => {
    const materialId = await importText('误删保护样本');
    const result = await actions.deleteMaterialAction({ materialId, confirmText: 'delete' });
    expect(result.ok).toBe(false);
    expect(await prisma.learningMaterial.count({ where: { id: materialId } })).toBe(1);
  });

  it('getMaterialImportContext 返回限额、来源文案与 accept', async () => {
    const context = await queries.getMaterialImportContext();
    expect(context.limits.maxFileBytes).toBe(MATERIAL_LIMITS.maxFileBytes);
    expect(context.limits.maxPdfPages).toBe(MATERIAL_LIMITS.maxPdfPages);
    expect(context.limits.maxChunks).toBe(MATERIAL_LIMITS.maxChunks);
    expect(context.limits.maxAiCalls).toBe(MATERIAL_LIMITS.maxAiCalls);
    expect(context.limits.maxPastedChars).toBe(MATERIAL_LIMITS.maxPastedChars);
    expect(context.accept).toContain('.pdf');
    expect(context.accept).toContain('.docx');
    expect(context.sourceTypes).toHaveLength(7);
    expect(context.sourceTypes.find((item) => item.value === 'unknown')?.restricted).toBe(true);
    expect(context.sourceTypes.find((item) => item.value === 'open_license')?.requiresLicenseName).toBe(true);
    expect(context.sourceTypes.find((item) => item.value === 'user_provided_url')?.requiresUrl).toBe(true);
    expect(context.supportedFormats.filter((item) => item.priority === 'P0')).toHaveLength(6);
    expect(context.existingMaterialCount).toBeGreaterThanOrEqual(0);
  });

  it('listFailedMaterials 按 contentHash 合并', async () => {
    const firstId = await importText('失败合并样本');
    await prisma.learningMaterial.update({
      where: { id: firstId },
      data: { status: 'failed', statusReason: '模拟失败' },
    });

    const rows = await queries.listFailedMaterials();
    const row = rows.find((item) => item.materialIds.includes(firstId));
    expect(row).toBeDefined();
    expect(row?.occurrences).toBeGreaterThanOrEqual(1);
    expect(row?.formatLabel).toBe('粘贴摘录');
  });
});
