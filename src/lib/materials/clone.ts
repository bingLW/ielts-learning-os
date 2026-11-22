/**
 * 材料复制（A-04「仍然另存为副本」的服务端实现）。
 *
 * 为什么从**已落盘的原文**复制而不是让客户端重传：去重命中时服务端已经读过一次
 * 字节、且原文文件还在磁盘上；重传要用户再等一次上传，还可能因为网络截断再失败。
 * 复制后新材料的 `duplicateOfId` 指向原材料，`contentHash` 与原材料相同 ——
 * 下次同内容导入仍会命中原材料的去重提示（这是期望行为）。
 */

import { readFileSync } from 'node:fs';
import type { MaterialStatus } from '@/lib/constants';
import { prisma } from '@/lib/prisma';
import { fail, ok } from '@/lib/result';
import {
  deleteMaterialDir,
  extensionFromFileName,
  resolveUploadPath,
  writeOriginalMaterialFile,
} from '@/lib/storage';
import type { ActionResult } from '@/lib/types';
import { createLocalId } from './id';

export interface CloneMaterialData {
  materialId: string;
  contentHash: string;
  duplicateOfId: string;
}

/** 复制一份材料（原文 + 来源 + 权限留痕 + 资产 + 新的处理任务）。 */
export async function cloneMaterialFromExisting(
  existingId: string,
): Promise<ActionResult<CloneMaterialData>> {
  const existing = await prisma.learningMaterial.findUnique({
    where: { id: existingId },
    select: {
      id: true,
      title: true,
      format: true,
      status: true,
      sourceType: true,
      language: true,
      originFileName: true,
      contentHash: true,
      targetSkillsJson: true,
      assets: {
        where: { kind: 'ORIGINAL_FILE' },
        select: { relativePath: true, fileName: true, mimeType: true, sha256: true },
        take: 1,
      },
      source: true,
    },
  });
  if (!existing) return fail<CloneMaterialData>('NOT_FOUND', '要复制的材料不存在');

  const asset = existing.assets[0];
  if (!asset) {
    return fail<CloneMaterialData>('PRECONDITION', '这份材料没有原文文件，无法另存副本');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveUploadPath(asset.relativePath));
  } catch {
    return fail<CloneMaterialData>('INTERNAL', '读取原材料文件失败（文件可能已被移动）');
  }

  const materialId = createLocalId('cm');
  const extension = extensionFromFileName(asset.fileName ?? asset.relativePath) || 'txt';

  let stored;
  try {
    stored = writeOriginalMaterialFile(bytes, materialId, extension);
  } catch {
    return fail<CloneMaterialData>('INTERNAL', '副本落盘失败，请检查存储目录权限');
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.learningMaterial.create({
        data: {
          id: materialId,
          title: `${existing.title}（副本）`.slice(0, 200),
          format: existing.format,
          // 副本从零开始解析（不继承 chunk，避免「同一份原文两个版本」的溯源混乱）
          status: 'created' satisfies MaterialStatus,
          sourceType: existing.sourceType,
          language: existing.language,
          originFileName: existing.originFileName,
          fileHash: stored.sha256,
          contentHash: existing.contentHash,
          targetSkillsJson: existing.targetSkillsJson,
          duplicateOfId: existing.id,
        },
      });

      if (existing.source) {
        await tx.materialSource.create({
          data: {
            materialId,
            sourceType: existing.source.sourceType,
            url: existing.source.url,
            author: existing.source.author,
            publisher: existing.source.publisher,
            publishedYear: existing.source.publishedYear,
            licenseName: existing.source.licenseName,
            licenseUrl: existing.source.licenseUrl,
            userNote: existing.source.userNote,
            rightsConfirmed: existing.source.rightsConfirmed,
            rightsConfirmedAt: existing.source.rightsConfirmedAt,
          },
        });
      }

      await tx.materialPermissionRecord.create({
        data: {
          materialId,
          action: 'RIGHTS_CONFIRMED',
          rule: 'duplicate_keep_copy',
          note: `沿用原材料 ${existing.id} 的权利确认记录`,
        },
      });
      if (existing.sourceType === 'unknown') {
        await tx.materialPermissionRecord.create({
          data: {
            materialId,
            action: 'EXPORT_BLOCKED',
            rule: 'sourceType=unknown',
            note: '来源不确定：禁止导出与原文下载',
          },
        });
      }

      await tx.materialAsset.create({
        data: {
          materialId,
          kind: 'ORIGINAL_FILE',
          relativePath: stored.relativePath,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          isReadOnly: true,
        },
      });

      await tx.processingJob.create({
        data: {
          materialId,
          stage: 'validating',
          status: 'running',
          attempt: 1,
          progressJson: JSON.stringify({
            stage: 'validating',
            done: 0,
            total: 1,
            unitLabel: '文件',
          }),
        },
      });
    });
  } catch {
    // 事务失败：清掉落盘的副本目录，避免孤儿文件
    deleteMaterialDir(materialId);
    return fail<CloneMaterialData>('INTERNAL', '副本入库失败，已回滚');
  }

  return ok<CloneMaterialData>({
    materialId,
    contentHash: existing.contentHash,
    duplicateOfId: existing.id,
  });
}
