'use server';

/**
 * 材料域 Server Actions（T08 的 8 个；T09–T13 在本文件追加其余）。
 *
 * 统一约定（与 v2.x 既有 action 一致）：
 * - 先 `safeParse`，失败 `failValidation`（fieldErrors 直接喂给 `FormField.error`）；
 * - 失败**返回**不 throw；
 * - 破坏性/不可逆操作必须二次确认（删除要手打 `DELETE`）；
 * - 任何写库后 `revalidatePath`，让 Server Component 页面数据失效。
 */

import { revalidatePath } from 'next/cache';
import type { MaterialStatus } from '@/lib/constants';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  materialAudioMetaSchema,
  materialDeleteSchema,
  materialDuplicateChoiceSchema,
  materialIdSchema,
  materialPastedExcerptSchema,
  materialRetrySchema,
  materialSourceSchema,
} from '@/lib/schema/material';
import { nullIfEmpty } from '@/lib/schema/common';
import { deleteMaterialDir } from '@/lib/storage';
import type { ActionResult } from '@/lib/types';
import { cloneMaterialFromExisting } from '@/lib/materials/clone';
import { createLocalId } from '@/lib/materials/id';
import { finalizeMaterialUpload, normalizePastedText } from '@/lib/materials/upload';
import { isCancellable, isTerminal } from '@/lib/materials/stateMachine';

/** 导入向导与材料库共用的失效路径。 */
function revalidateMaterialPaths(materialId?: string): void {
  revalidatePath('/materials');
  revalidatePath('/materials/failed');
  revalidatePath('/materials/import');
  if (materialId) revalidatePath(`/materials/${materialId}/processing`);
}

export interface ImportedMaterialData {
  materialId: string;
  contentHash: string;
  duplicateOf?: string;
}

/** 粘贴摘录导入（走与文件上传同一条落库通道）。 */
export async function importPastedExcerptAction(
  raw: unknown,
): Promise<ActionResult<ImportedMaterialData>> {
  const parsed = materialPastedExcerptSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error, '粘贴内容不完整');

  const input = parsed.data;
  const text = normalizePastedText(input.text);
  if (text.length === 0) {
    return fail<ImportedMaterialData>('VALIDATION', '请粘贴一段文本', {
      text: '粘贴内容为空',
    });
  }

  const formData = new FormData();
  formData.set(
    'meta',
    JSON.stringify({
      title: input.title ?? '',
      language: input.language ?? '',
      targetSkills: input.targetSkills,
      pastedText: text,
      source: input.source,
    }),
  );

  const result = await finalizeMaterialUpload(formData);
  if (!result.ok) return result;

  revalidateMaterialPaths(result.data.materialId);
  return ok<ImportedMaterialData>({
    materialId: result.data.materialId,
    contentHash: result.data.contentHash,
    duplicateOf: result.data.duplicateOf,
  });
}

/**
 * 文件上传的 Server Action 包装。
 *
 * 落盘/去重/入库逻辑**只有一份**（`src/lib/materials/upload.ts`），
 * Route Handler（`/api/upload-material`）与本 action 共用，避免两套实现漂移。
 */
export async function finalizeMaterialUploadAction(
  formData: FormData,
): Promise<ActionResult<ImportedMaterialData>> {
  const result = await finalizeMaterialUpload(formData);
  if (!result.ok) return result;
  revalidateMaterialPaths(result.data.materialId);
  return ok<ImportedMaterialData>({
    materialId: result.data.materialId,
    contentHash: result.data.contentHash,
    duplicateOf: result.data.duplicateOf,
  });
}

/**
 * 去重命中后的二选一（A-04）。
 *
 * - `open_existing`：直接打开已有材料（`materialId` 就是既有 id）；
 * - `keep_copy`：从既有材料的原文复制一份，`duplicateOfId` 指向它。
 *
 * 传入的 `materialId` 是**已存在的**那条材料 id（`finalizeMaterialUpload` 命中
 * 去重时返回的 `duplicateOf`），因此这两个分支都不会产生「半成品」记录。
 */
export async function confirmDuplicateChoiceAction(
  raw: unknown,
): Promise<ActionResult<{ materialId: string; created: boolean }>> {
  const parsed = materialDuplicateChoiceSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, choice } = parsed.data;
  const existing = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true },
  });
  if (!existing) return fail('NOT_FOUND', '材料不存在或已被删除');

  if (choice === 'open_existing') {
    return ok({ materialId: existing.id, created: false });
  }

  const cloned = await cloneMaterialFromExisting(existing.id);
  if (!cloned.ok) return cloned;
  revalidateMaterialPaths(cloned.data.materialId);
  return ok({ materialId: cloned.data.materialId, created: true });
}

/** 更新来源与权限登记（导入后仍可补全，A-05）。 */
export async function updateMaterialSourceAction(
  raw: unknown,
): Promise<ActionResult<{ materialId: string; restricted: boolean }>> {
  const input = raw as { materialId?: unknown; source?: unknown } | null;
  const idParsed = materialIdSchema.safeParse({ materialId: input?.materialId });
  if (!idParsed.success) return failValidation(idParsed.error);

  // 允许 `{ materialId, source: {...} }` 与 `{ materialId, ...source }` 两种形态
  const sourceCandidate =
    input && typeof input === 'object' && 'source' in input && input.source
      ? input.source
      : raw;
  const sourceParsed = materialSourceSchema.safeParse(sourceCandidate);
  if (!sourceParsed.success) return failValidation(sourceParsed.error);

  const materialId = idParsed.data.materialId;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, sourceType: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const source = sourceParsed.data;
  const sourceData = {
    sourceType: source.sourceType,
    url: nullIfEmpty(source.url),
    author: nullIfEmpty(source.author),
    publisher: nullIfEmpty(source.publisher),
    publishedYear: source.publishedYear ?? null,
    licenseName: nullIfEmpty(source.licenseName),
    licenseUrl: nullIfEmpty(source.licenseUrl),
    userNote: nullIfEmpty(source.userNote),
    rightsConfirmed: true,
    rightsConfirmedAt: new Date(),
  };

  const restricted = source.sourceType === 'unknown';

  await prisma.$transaction(async (tx) => {
    await tx.materialSource.upsert({
      where: { materialId },
      create: { materialId, ...sourceData },
      update: sourceData,
    });
    await tx.learningMaterial.update({
      where: { id: materialId },
      data: { sourceType: source.sourceType },
    });
    await tx.materialPermissionRecord.create({
      data: {
        materialId,
        action: 'RIGHTS_CONFIRMED',
        rule: 'source_update',
        note: `sourceType=${source.sourceType}`,
      },
    });
    // 来源改为不确定 → 追加一条导出限制留痕（旧记录 append-only，不删不改）
    if (restricted) {
      await tx.materialPermissionRecord.create({
        data: {
          materialId,
          action: 'EXPORT_BLOCKED',
          rule: 'sourceType=unknown',
          note: '来源不确定：禁止导出与原文下载',
        },
      });
    }
  });

  revalidateMaterialPaths(materialId);
  revalidatePath(`/materials/${materialId}/source`);
  return ok({ materialId, restricted });
}

/**
 * 取消处理（A-07）。
 *
 * 只置 `cancelRequested=true`，**不强杀进程**：正在跑的解析/分块会在下一个
 * await 边界收敛（`pipeline.ts` 的 `applyOutcome` 负责把两个表都改成 cancelled）。
 * 终态材料直接返回当前状态，不写库。
 */
export async function cancelMaterialJobAction(
  raw: unknown,
): Promise<ActionResult<{ status: MaterialStatus }>> {
  const parsed = materialIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const material = await prisma.learningMaterial.findUnique({
    where: { id: parsed.data.materialId },
    select: { id: true, status: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const status = material.status as MaterialStatus;
  // 终态、以及"等你裁决"的 `review_required`：都没有正在跑的任务，直接返回当前状态。
  // （后者曾经因为 job 仍标记 running 而能"取消"，现在 job 已正常收尾为 succeeded，
  //  再去找 running job 只会报 CONFLICT —— 那不是用户视角的错误。）
  if (isTerminal(status) || !isCancellable(status)) {
    return ok({ status });
  }

  const running = await prisma.processingJob.findFirst({
    where: { materialId: material.id, status: 'running' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  if (!running) {
    return fail('CONFLICT', '当前没有正在处理的任务，可能已结束');
  }

  await prisma.processingJob.update({
    where: { id: running.id },
    data: { cancelRequested: true },
  });

  revalidateMaterialPaths(material.id);
  return ok({ status });
}

/**
 * 重试（A-08）。
 *
 * 语义：`failed → created`，`attempt + 1`，**复用已解析的 chunk**：
 * - 若已有 current `ParsedDocument`（说明失败发生在 normalizing 之后）→ 从 `normalizing` 续跑；
 * - 否则从 `validating` 重新开始（原文仍在，无需重传）。
 *
 * 旧 job 被置为 `failed`（保持历史），新 job 是新行，`lockVersion` 从 0 开始。
 */
export async function retryMaterialJobAction(
  raw: unknown,
): Promise<ActionResult<{ jobId: string; attempt: number; fromStage: string }>> {
  const parsed = materialRetrySchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, status: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (material.status !== 'failed') {
    return fail(
      'PRECONDITION',
      '只有失败的材料可以重试；处理中请先等待结束或取消',
    );
  }

  const lastJob = await prisma.processingJob.findFirst({
    where: { materialId },
    orderBy: { startedAt: 'desc' },
    select: { attempt: true, progressJson: true },
  });
  const attempt = (lastJob?.attempt ?? 0) + 1;

  // 已有解析结果 → 只重跑分块，省掉一次完整解析（PDF 尤其明显）
  const parsedDocument = await prisma.parsedDocument.findFirst({
    where: { materialId, isCurrent: true },
    select: { id: true },
  });
  const hasSnapshot = await prisma.materialAsset.findFirst({
    where: { materialId, kind: 'PARSED_JSON' },
    select: { id: true },
  });

  const fromStage =
    parsed.data.fromStage ??
    (parsedDocument || hasSnapshot ? 'normalizing' : 'validating');

  const job = await prisma.$transaction(async (tx) => {
    // 旧 job 收尾（保持历史可追溯），新 job 承载本次尝试
    await tx.processingJob.updateMany({
      where: { materialId, status: 'running' },
      data: {
        status: 'failed',
        errorMessage: '已被新的重试任务取代',
        finishedAt: new Date(),
      },
    });

    const created = await tx.processingJob.create({
      data: {
        materialId,
        stage: fromStage,
        status: 'running',
        attempt,
        cancelRequested: false,
        progressJson: stringify({ stage: fromStage, done: 0, total: 1, unitLabel: '项' }),
      },
      select: { id: true },
    });

    await tx.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'created', statusReason: null },
    });

    return created;
  });

  revalidateMaterialPaths(materialId);
  return ok({ jobId: job.id, attempt, fromStage });
}

/**
 * 删除材料（G-01/G-02）。
 *
 * 本批实现「基本删除 + 计数」：同一事务内显式删除 17 张派生表的行，
 * **保留** `VocabularyItem` / `EvidenceRecord` / `PlanTask`（它们与材料没有外键），
 * 并把 `AICallLog.materialId` 置 null（账本保留，费用归属仍可查 job id）。
 * 文件目录在事务成功后删除（删文件不可回滚，放最后）。
 */
export async function deleteMaterialAction(
  raw: unknown,
): Promise<ActionResult<{
  deletedRows: number;
  keptVocabularyItems: number;
  keptPlanTasks: number;
  keptAttempts: number;
}>> {
  const parsed = materialDeleteSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const materialId = parsed.data.materialId;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true },
  });
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const keptVocabularyItems = await prisma.vocabularyCandidate.count({
    where: { materialId, syncStatus: 'synced' },
  });
  const keptPlanTasks = await prisma.taskProposalItem.count({
    where: { proposal: { materialId, status: 'confirmed' } },
  });
  const keptAttempts = await prisma.exerciseAttempt.count({
    where: { materialId, evidenceId: { not: null } },
  });

  const deletedRows = await prisma.$transaction(async (tx) => {
    let total = 0;
    const track = (result: { count: number }): void => {
      total += result.count;
    };

    // 依赖顺序：叶子 → 主体（不依赖级联，显式删除让 deletedRows 可解释）
    track(await tx.taskProposalItem.deleteMany({ where: { proposal: { materialId } } }));
    track(await tx.taskProposal.deleteMany({ where: { materialId } }));
    track(await tx.materialPackItem.deleteMany({ where: { pack: { materialId } } }));
    track(await tx.materialPack.deleteMany({ where: { materialId } }));
    track(await tx.exerciseAttempt.deleteMany({ where: { materialId } }));
    track(await tx.generatedExercise.deleteMany({ where: { materialId } }));
    track(await tx.materialExerciseSet.deleteMany({ where: { materialId } }));
    track(await tx.sentenceCandidate.deleteMany({ where: { materialId } }));
    track(await tx.vocabularyCandidate.deleteMany({ where: { materialId } }));
    track(await tx.extractionResult.deleteMany({ where: { materialId } }));
    track(await tx.contentChunk.deleteMany({ where: { materialId } }));
    track(await tx.parsedDocument.deleteMany({ where: { materialId } }));
    track(await tx.processingJob.deleteMany({ where: { materialId } }));
    track(await tx.materialAsset.deleteMany({ where: { materialId } }));
    track(await tx.materialPermissionRecord.deleteMany({ where: { materialId } }));
    track(await tx.materialSource.deleteMany({ where: { materialId } }));

    // 账本保留：只断开归属（G-02：删材料不删账，费用仍可追溯）
    await tx.aICallLog.updateMany({
      where: { materialId },
      data: { materialId: null },
    });

    track(await tx.learningMaterial.deleteMany({ where: { id: materialId } }));
    return total;
  });

  deleteMaterialDir(materialId);

  revalidateMaterialPaths(materialId);
  return ok({ deletedRows, keptVocabularyItems, keptPlanTasks, keptAttempts });
}

/**
 * 音频材料登记（P1 降级）。
 *
 * 本期不做转写：只建 `AudioAsset(source='MATERIAL')` + `MaterialAsset(kind='AUDIO_REF')`，
 * 材料状态保持 `created`（状态机里没有 pending_transcription），
 * `statusReason` 明确写「音频待转写」，UI 据此显示不可分析的横幅。
 */
export async function registerMaterialAudioAction(
  raw: unknown,
): Promise<ActionResult<{ materialId: string; audioAssetId: string; status: 'pending_transcription' }>> {
  const parsed = materialAudioMetaSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const input = parsed.data;
  const audio = await prisma.audioAsset.findUnique({
    where: { id: input.audioAssetId },
    select: { id: true, title: true, filePath: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true, durationSec: true },
  });
  if (!audio) return fail('NOT_FOUND', '音频资产不存在，请先上传音频');

  const materialId = createLocalId('cm');
  const title = (input.title ?? '').trim() || audio.title;
  const contentHash = audio.sha256 ?? `audio:${audio.id}`;

  const duplicate = await prisma.learningMaterial.findFirst({
    where: { contentHash, duplicateOfId: null },
    select: { id: true },
  });
  if (duplicate) {
    return fail(
      'CONFLICT',
      '这段音频已经导入过（同内容已有材料），请到材料库查看',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.audioAsset.update({
      where: { id: audio.id },
      data: { source: 'MATERIAL' },
    });

    await tx.learningMaterial.create({
      data: {
        id: materialId,
        title: title.slice(0, 200),
        format: 'AUDIO',
        status: 'created',
        statusReason: '音频已登记，本期暂不转写（P1）',
        sourceType: input.source.sourceType,
        language: input.language?.trim() || 'en',
        contentHash,
      },
    });

    await tx.materialSource.create({
      data: {
        materialId,
        sourceType: input.source.sourceType,
        url: nullIfEmpty(input.source.url),
        author: nullIfEmpty(input.source.author),
        publisher: nullIfEmpty(input.source.publisher),
        publishedYear: input.source.publishedYear ?? null,
        licenseName: nullIfEmpty(input.source.licenseName),
        licenseUrl: nullIfEmpty(input.source.licenseUrl),
        userNote: nullIfEmpty(input.source.userNote),
        rightsConfirmed: true,
        rightsConfirmedAt: new Date(),
      },
    });

    await tx.materialPermissionRecord.create({
      data: {
        materialId,
        action: 'RIGHTS_CONFIRMED',
        rule: 'audio_register',
        note: `audioAssetId=${audio.id}`,
      },
    });

    await tx.materialAsset.create({
      data: {
        materialId,
        kind: 'AUDIO_REF',
        relativePath: audio.filePath,
        fileName: audio.fileName,
        mimeType: audio.mimeType,
        sizeBytes: audio.sizeBytes ?? null,
        sha256: audio.sha256,
        isReadOnly: true,
        audioAssetId: audio.id,
      },
    });
  });

  revalidateMaterialPaths(materialId);
  return ok({
    materialId,
    audioAssetId: audio.id,
    status: 'pending_transcription' as const,
  });
}
