/**
 * 材料导入的落库通道（T03）。
 *
 * 顺序（不能随便调换）：
 *   1. 校验表单（zod）→ 2. 大小预判 → 3. 魔数三方一致性 → 4. 生成 materialId
 *   → 5. 落盘原文（0444） → 6. 内容哈希去重查询 → 7. 单事务写
 *   `LearningMaterial` + `MaterialSource` + `MaterialPermissionRecord` + `MaterialAsset` + `ProcessingJob`
 *   → 8. 返回 materialId
 *
 * 为什么先落盘再做事务：文件写入不可回滚，若先建库记录再写文件，写盘失败就得
 * 补一条 delete（还可能与并发 tick 抢同一 material）。反过来的代价是「文件写了但
 * 事务失败」会留下孤儿目录 —— 用 `deleteMaterialDir` 显式清理，代价更小。
 *
 * 粘贴摘录（PASTED_TEXT）也走**同一套落盘 + 事务**：正文写成
 * `materials/{id}/original.txt`（`MaterialAsset.kind='ORIGINAL_FILE'`，0444）。
 * 这样下游（T07 解析 / T10 Reader）只有一条读取路径，且粘贴内容同样是不可篡改的
 * 原文基线；`format='PASTED_TEXT'` 只用于区分展示与「无原始文件名」。
 */

import type { MaterialFormat, MaterialStatus } from '@/lib/constants';
import { MATERIAL_ERROR_MESSAGES_ZH, MATERIAL_LIMITS } from '@/lib/constants';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { materialUploadMetaSchema, type MaterialUploadMeta } from '@/lib/schema/material';
import {
  extensionFromFileName,
  sha256Hex,
  writeOriginalMaterialFile,
  deleteMaterialDir,
  type StoredMaterialFile,
} from '@/lib/storage';
import type { ActionResult } from '@/lib/types';
import { countWords, fileNameToTitle, sanitizeDisplayFileName } from './displayName';
import { createLocalId } from './id';
import { checkFileSize, checkPastedChars } from './limits';
import { sniffFormat, sniffPlainText } from './magicNumber';

/** UI 需要展示的上限（导入向导第 1 步直接读它，避免前端硬编码数字）。 */
export interface MaterialUploadLimitsDto {
  maxFileBytes: number;
  maxPdfPages: number;
  maxChunks: number;
  maxAiCalls: number;
  maxPastedChars: number;
}

export interface FinalizeMaterialData {
  materialId: string;
  contentHash: string;
  format: MaterialFormat;
  /**
   * 命中同 `contentHash` 的既有材料时给出其 id：
   * - `duplicateOf` 有值 ⇒ **没有新建任何记录**，`materialId` 指向既有材料，
   *   前端据此展示「打开已有 / 另存为副本」二选一（PRD A-04）。
   */
  duplicateOf?: string;
  limits: MaterialUploadLimitsDto;
}

export const MATERIAL_UPLOAD_LIMITS: MaterialUploadLimitsDto = {
  maxFileBytes: MATERIAL_LIMITS.maxFileBytes,
  maxPdfPages: MATERIAL_LIMITS.maxPdfPages,
  maxChunks: MATERIAL_LIMITS.maxChunks,
  maxAiCalls: MATERIAL_LIMITS.maxAiCalls,
  maxPastedChars: MATERIAL_LIMITS.maxPastedChars,
};

/** 超限错误标记（Route Handler 用它把 400 升为 413）。 */
const OVERSIZE_MARKERS = [MATERIAL_ERROR_MESSAGES_ZH.FILE_TOO_LARGE ?? '', '上限'];

/** 该失败是否属于「文件过大」（路由层应回 413 而不是 400）。 */
export function isOversizeFailure(message: string): boolean {
  return OVERSIZE_MARKERS.some((marker) => marker.length > 0 && message.includes(marker));
}

/** 粘贴文本规范化：统一换行、去首尾空白、折叠 3+ 空行。 */
export function normalizePastedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface PreparedSource {
  bytes: Buffer;
  format: MaterialFormat;
  extension: string;
  declaredMime: string | null;
  originFileName: string | null;
  title: string;
  charCount: number;
  wordCount: number;
}

/** 把「文件」这一支解析成待落盘的数据；失败返回可读错误。 */
async function prepareFromFile(
  file: File,
  meta: MaterialUploadMeta,
): Promise<{ ok: true; prepared: PreparedSource } | { ok: false; error: string; field: string }> {
  const bytes = Buffer.from(await file.arrayBuffer());

  const sizeCheck = checkFileSize(bytes.byteLength);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.message, field: 'file' };

  const displayName = sanitizeDisplayFileName(file.name);
  const verdict = sniffFormat({
    bytes,
    declaredMime: file.type || null,
    fileName: file.name,
  });
  if (!verdict.ok) {
    return { ok: false, error: verdict.message, field: 'file' };
  }

  return {
    ok: true,
    prepared: {
      bytes,
      format: verdict.format,
      extension: extensionFromFileName(file.name) || 'txt',
      declaredMime: file.type || null,
      originFileName: displayName,
      title: (meta.title ?? '').trim() || fileNameToTitle(file.name),
      charCount: 0,
      wordCount: 0,
    },
  };
}

/** 粘贴摘录这一支；同样是「一段文本 → 待落盘字节」。 */
function prepareFromPastedText(
  text: string,
  meta: MaterialUploadMeta,
): { ok: true; prepared: PreparedSource } | { ok: false; error: string; field: string } {
  const normalized = normalizePastedText(text);
  const charsCheck = checkPastedChars(normalized.length);
  if (!charsCheck.ok) return { ok: false, error: charsCheck.message, field: 'pastedText' };

  const bytes = Buffer.from(normalized, 'utf8');
  const sizeCheck = checkFileSize(bytes.byteLength);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.message, field: 'pastedText' };

  if (!sniffPlainText(bytes).ok) {
    return {
      ok: false,
      error: '粘贴内容里含有大量不可见字符或乱码，请重新粘贴纯文本',
      field: 'pastedText',
    };
  }

  return {
    ok: true,
    prepared: {
      bytes,
      format: 'PASTED_TEXT',
      extension: 'txt',
      declaredMime: 'text/plain',
      originFileName: null,
      title: (meta.title ?? '').trim() || normalized.slice(0, 40).replace(/\s+/g, ' ') || '粘贴摘录',
      charCount: normalized.length,
      wordCount: countWords(normalized),
    },
  };
}

/**
 * 材料导入的最终落库动作（Server Action / Route Handler 共用）。
 *
 * @param formData 字段：`file?: File`、`meta: string(JSON，materialUploadMetaSchema)`
 */
export async function finalizeMaterialUpload(
  formData: FormData,
): Promise<ActionResult<FinalizeMaterialData>> {
  // ── 1. meta 校验 ──────────────────────────────────────────────────
  const metaRaw = formData.get('meta');
  let rawMeta: unknown = {};
  if (metaRaw !== null) {
    try {
      rawMeta = JSON.parse(String(metaRaw));
    } catch {
      return fail('VALIDATION', 'meta 不是合法 JSON', { meta: 'meta 不是合法 JSON' });
    }
  }
  const parsedMeta = materialUploadMetaSchema.safeParse(rawMeta);
  if (!parsedMeta.success) return failValidation(parsedMeta.error, '材料信息不完整');
  const meta = parsedMeta.data;

  // ── 2. 文件 / 粘贴二选一 ──────────────────────────────────────────
  const fileEntry = formData.get('file');
  const file = fileEntry instanceof File ? fileEntry : null;
  const pastedRaw = (meta.pastedText ?? '').trim();

  if (file && pastedRaw) {
    return fail('VALIDATION', '文件与粘贴内容只能二选一', { file: '请只选择一种导入方式' });
  }
  if (!file && !pastedRaw) {
    return fail('VALIDATION', '请上传文件，或粘贴一段文本', { file: '缺少文件或粘贴内容' });
  }

  const preparedResult = file
    ? await prepareFromFile(file, meta)
    : prepareFromPastedText(pastedRaw, meta);
  if (!preparedResult.ok) {
    return fail('VALIDATION', preparedResult.error, { [preparedResult.field]: preparedResult.error });
  }
  const prepared = preparedResult.prepared;

  // ── 3. 内容哈希去重（A-04：命中不新建，交给用户二选一） ────────────
  const contentHash = sha256Hex(prepared.bytes);
  const duplicate = await prisma.learningMaterial.findFirst({
    where: { contentHash, duplicateOfId: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (duplicate) {
    return ok({
      materialId: duplicate.id,
      contentHash,
      format: prepared.format,
      duplicateOf: duplicate.id,
      limits: MATERIAL_UPLOAD_LIMITS,
    });
  }

  // ── 4. 落盘（先文件、后事务；失败时清理目录） ──────────────────────
  const materialId = createLocalId('cm');
  let stored: StoredMaterialFile;
  try {
    stored = writeOriginalMaterialFile(prepared.bytes, materialId, prepared.extension);
  } catch {
    return fail('INTERNAL', '材料落盘失败，请检查存储目录权限');
  }

  const isPasted = prepared.format === 'PASTED_TEXT';
  const status: MaterialStatus = 'created';
  const targetSkillsJson =
    meta.targetSkills && meta.targetSkills.length > 0 ? stringify(meta.targetSkills) : null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.learningMaterial.create({
        data: {
          id: materialId,
          title: prepared.title,
          format: prepared.format,
          status,
          sourceType: meta.source.sourceType,
          language: meta.language?.trim() || 'en',
          originFileName: prepared.originFileName,
          // PASTED_TEXT 没有「原始文件」，按 schema 约定 fileHash 为 null
          fileHash: isPasted ? null : stored.sha256,
          contentHash,
          charCount: prepared.charCount,
          wordCount: prepared.wordCount,
          targetSkillsJson,
        },
      });

      await tx.materialSource.create({
        data: {
          materialId,
          sourceType: meta.source.sourceType,
          url: meta.source.url ?? null,
          author: meta.source.author ?? null,
          publisher: meta.source.publisher ?? null,
          publishedYear: meta.source.publishedYear ?? null,
          licenseName: meta.source.licenseName ?? null,
          licenseUrl: meta.source.licenseUrl ?? null,
          userNote: meta.source.userNote ?? null,
          rightsConfirmed: true,
          rightsConfirmedAt: new Date(),
        },
      });

      // 权限留痕（append-only）：每次导入都证明"用户当时确认过权利"
      await tx.materialPermissionRecord.create({
        data: {
          materialId,
          action: 'RIGHTS_CONFIRMED',
          rule: 'import_rights_confirmed',
          note: `sourceType=${meta.source.sourceType}`,
        },
      });
      if (meta.source.sourceType === 'unknown') {
        // 来源不确定：从导入那一刻起就受限（导出/下载），先落痕再提示（R1/R2）
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
          fileName: prepared.originFileName ?? 'pasted-text.txt',
          mimeType: prepared.declaredMime ?? (isPasted ? 'text/plain' : 'application/octet-stream'),
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          // 原文资产只读（应用层禁写 + 落盘 0444 双保险）
          isReadOnly: true,
        },
      });

      await tx.processingJob.create({
        data: {
          materialId,
          stage: 'validating',
          // schema 的 status 取值是 running|succeeded|failed|cancelled（无 queued），
          // 初始即 running，由 tick 引擎推进（T08）
          status: 'running',
          progressJson: stringify({ stage: 'validating', done: 0, total: 1, unitLabel: '文件' }),
        },
      });

      await tx.learningMaterial.update({
        where: { id: materialId },
        data: { status },
      });
    });
  } catch {
    deleteMaterialDir(materialId);
    return fail('INTERNAL', '材料入库失败，已回滚并清理文件');
  }

  return ok({
    materialId,
    contentHash,
    format: prepared.format,
    limits: MATERIAL_UPLOAD_LIMITS,
  });
}
