/**
 * 阶段 1：validating —— 文件自检（不解析正文）。
 *
 * 状态机约束：`validating → extracting`（通过）/ `validating → failed`
 * （INVALID_MAGIC / FILE_TOO_LARGE / PDF_TOO_MANY_PAGES）。
 *
 * 全部检查都基于**已落盘的原文**，不信任客户端声明的 MIME/扩展名：
 * 1. 原文资产必须存在且可读；
 * 2. 体积 ≤ 20 MB（落盘时已校验一次，这里复核，防止磁盘被外部替换）；
 * 3. 魔数三方一致性（扩展名 / 内容形态 / MIME）且与 `LearningMaterial.format` 一致；
 * 4. PDF 打开后**先读 numPages**，超 200 页立即拒绝（一页都不解析）。
 *
 * PDF 这一步会真的打开一次文档（只读 xref），比「解析完再看页数」省得多；
 * 代价是 extracting 会再打开一次 —— 单机单并发下这个开销可以接受。
 */

import { readFileSync } from 'node:fs';
import { MATERIAL_ERROR_MESSAGES_ZH } from '@/lib/constants';
import { checkFileSize, checkPdfPages } from '@/lib/materials/limits';
import { sniffFormat, sniffPlainText } from '@/lib/materials/magicNumber';
import { loadPdfDocument } from '@/lib/materials/pdf';
import { prisma } from '@/lib/prisma';
import { resolveUploadPath } from '@/lib/storage';
import {
  stageCancelled,
  stageFailure,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from '../stageContract';

/**
 * 魔数嗅探出的格式与材料登记的格式是否「同一类」。
 *
 * 只有 `MARKDOWN ↔ TXT` 是允许的模糊地带：两者都是纯文本，
 * 嗅探器只能靠扩展名区分（`.md` 记成 MARKDOWN，其余记成 TXT）。
 */
function formatMatches(materialFormat: string, verdictFormat: string): boolean {
  if (materialFormat === verdictFormat) return true;
  const pair = new Set([materialFormat, verdictFormat]);
  return pair.has('MARKDOWN') && pair.has('TXT');
}

export const validatingStage: StageHandler = async (ctx: StageContext): Promise<StageOutcome> => {
  const { material } = ctx;

  const asset = await prisma.materialAsset.findFirst({
    where: { materialId: material.id, kind: 'ORIGINAL_FILE' },
    select: { relativePath: true, fileName: true, mimeType: true, sizeBytes: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!asset) {
    return stageFailure(
      'validating',
      'INVALID_MAGIC',
      '材料原文缺失，无法解析，请删除后重新导入',
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveUploadPath(asset.relativePath));
  } catch {
    return stageFailure(
      'validating',
      'INVALID_MAGIC',
      '读取原文文件失败（文件可能已被移动），请删除后重新导入',
    );
  }

  // ── 体积复核 ──────────────────────────────────────────────────────
  const sizeCheck = checkFileSize(bytes.byteLength);
  if (!sizeCheck.ok) {
    return stageFailure('validating', sizeCheck.code, sizeCheck.message);
  }

  // ── 魔数三方一致性 ────────────────────────────────────────────────
  if (material.format === 'PASTED_TEXT') {
    // 粘贴摘录没有扩展名语义，只做「可解码 + 无 NUL + 控制符不超标」
    if (!sniffPlainText(bytes).ok) {
      return stageFailure(
        'validating',
        'INVALID_MAGIC',
        '粘贴内容里含有大量不可见字符或乱码，无法解析',
      );
    }
  } else {
    const verdict = sniffFormat({
      bytes,
      declaredMime: asset.mimeType ?? null,
      fileName: asset.fileName ?? `original.${material.format.toLowerCase()}`,
    });
    if (!verdict.ok) {
      return stageFailure('validating', verdict.code, verdict.message);
    }
    if (!formatMatches(material.format, verdict.format)) {
      return stageFailure(
        'validating',
        'MAGIC_MISMATCH',
        MATERIAL_ERROR_MESSAGES_ZH.MAGIC_MISMATCH ?? '文件内容与声明的格式不符',
      );
    }
  }

  // ── PDF 页数（读 numPages 即拒，不解页）──────────────────────────
  if (material.format === 'PDF') {
    let document: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
    try {
      document = await loadPdfDocument(bytes);
      const pageCheck = checkPdfPages(document.numPages);
      if (!pageCheck.ok) {
        return stageFailure('validating', pageCheck.code, pageCheck.message);
      }
    } catch {
      return stageFailure(
        'validating',
        'INVALID_MAGIC',
        'PDF 文件已损坏或无法打开，请重新导出后再导入',
      );
    } finally {
      if (document) await document.destroy();
    }
  }

  if (await ctx.isCancelled()) return stageCancelled(ctx);

  return {
    to: 'extracting',
    stage: 'extracting',
    progress: { done: 1, total: 1, unitLabel: '自检项' },
    statusReason: null,
    didWork: true,
  };
};
