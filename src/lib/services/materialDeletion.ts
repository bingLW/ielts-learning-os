/**
 * 材料删除的级联实现（T14，AC-09 / G-01 / G-02）。
 *
 * 删除策略（与 `docs/32` §6.5 一致）：
 * - 派生内容（17 张派生表）显式删除，`deletedRows` 可解释；
 * - **用户资产保留**：`VocabularyItem`（主库词条）、`EvidenceRecord`（作答证据）、
 *   `PlanTask`（已确认的计划任务）都没有指向材料的 Prisma 关系，天然不会被级联；
 * - **归属行删除**：`VocabularyItemSource` 里 `sourceRef = materialId` 的那几行
 *   是「词条来自这份材料」的登记，材料删了要一并删（只删归属行，**不删词条**）；
 * - 账本保留：`AICallLog.materialId` 置 null，费用仍可按 job id 追溯；
 * - 磁盘目录在事务成功后删除（删文件不可回滚，放最后），失败只降级为 warning。
 */

import { prisma } from '@/lib/prisma';
import { deleteMaterialDir } from '@/lib/storage';

export interface MaterialDeletionResult {
  /** 显式删除的行数（17 张派生表 + 归属行 + 材料主行）。 */
  deletedRows: number;
  /** 保留的主库词条数（本材料同步进 `VocabularyItem` 的、去重后的词条）。 */
  keptVocabularyItems: number;
  /** 保留的计划任务数（已确认草案里回写的 `PlanTask`，去重）。 */
  keptPlanTasks: number;
  /** 保留的作答证据数（带 `evidenceId` 的作答对应的 `EvidenceRecord`）。 */
  keptAttempts: number;
  /** 磁盘目录删除失败时的人话告警（不含绝对路径）；成功为 null。 */
  warning: string | null;
}

/** 材料不存在时返回 null；调用方（action）负责把它转成 `NOT_FOUND`。 */
export async function deleteMaterialWithCascade(
  materialId: string,
): Promise<MaterialDeletionResult | null> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true },
  });
  if (!material) return null;

  // —— 保留项在删除前快照（删完就查不到了）——
  // Prisma 的 `count` 不支持 `distinct`，用 `findMany({ distinct, select })` 数长度。
  const keptVocabularyItems = await prisma.vocabularyItemSource
    .findMany({ where: { sourceRef: materialId }, distinct: ['itemId'], select: { itemId: true } })
    .then((rows) => rows.length);
  const keptPlanTasks = await prisma.taskProposalItem
    .findMany({
      where: { proposal: { materialId, status: 'confirmed' }, planTaskId: { not: null } },
      distinct: ['planTaskId'],
      select: { planTaskId: true },
    })
    .then((rows) => rows.length);
  const keptAttempts = await prisma.exerciseAttempt
    .findMany({
      where: { materialId, evidenceId: { not: null } },
      distinct: ['evidenceId'],
      select: { evidenceId: true },
    })
    .then((rows) => rows.length);

  let deletedRows = 0;
  await prisma.$transaction(async (tx) => {
    const track = (result: { count: number }): void => {
      deletedRows += result.count;
    };

    // 依赖顺序：叶子 → 主体（不依赖 Prisma 级联，显式删除让数字可解释）。
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

    // 归属行：删「词条来自这份材料」的登记，词条本体保留。
    track(await tx.vocabularyItemSource.deleteMany({ where: { sourceRef: materialId } }));

    // 账本保留：断开材料归属，费用仍按 job id 追溯。
    await tx.aICallLog.updateMany({ where: { materialId }, data: { materialId: null } });

    track(await tx.learningMaterial.deleteMany({ where: { id: materialId } }));
  });

  let warning: string | null = null;
  try {
    deleteMaterialDir(materialId);
  } catch {
    warning = '派生文件目录未能删除，可稍后重试或手动清理';
  }

  return { deletedRows, keptVocabularyItems, keptPlanTasks, keptAttempts, warning };
}
