/**
 * 材料域资源限制的**纯函数校验**（架构 §5）。
 *
 * 为什么把阈值判断集中在这里：同一组数字（20MB / 200 页 / 800 chunk / 40MB 解压 …）
 * 会在上传、解析、分块、AI 分析四处被检查，散落判断必然漂移；这里只做判断、
 * 不做 IO、不抛异常，因此可以被穷举单测。
 *
 * 返回 `code` 一律取自 `MATERIAL_ERROR_CODES`，UI 用它查中文文案。
 */

import { MATERIAL_ERROR_MESSAGES_ZH, MATERIAL_LIMITS } from '@/lib/constants';

export type LimitCheck = { ok: true } | { ok: false; code: string; message: string };

const PASS: LimitCheck = { ok: true };

function fail(code: keyof typeof MATERIAL_ERROR_MESSAGES_ZH, message?: string): LimitCheck {
  return { ok: false, code, message: message ?? MATERIAL_ERROR_MESSAGES_ZH[code] };
}

/** 人类可读的 MB 数（保留 1 位小数，避免 19.999 这类噪声）。 */
export function formatBytesMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

/** 单文件大小：≤ 20 MB。 */
export function checkFileSize(bytes: number): LimitCheck {
  if (!Number.isFinite(bytes) || bytes < 0) return fail('EMPTY_FILE', '文件大小不合法');
  if (bytes === 0) return fail('EMPTY_FILE');
  if (bytes > MATERIAL_LIMITS.maxFileBytes) {
    return fail('FILE_TOO_LARGE', `文件超过 ${formatBytesMb(MATERIAL_LIMITS.maxFileBytes)} 上限`);
  }
  return PASS;
}

/** PDF 页数：≤ 200 页（超限直接拒绝，不解页）。 */
export function checkPdfPages(pages: number): LimitCheck {
  if (!Number.isFinite(pages) || pages <= 0) return fail('NO_TEXT', 'PDF 没有可读取的页面');
  if (pages > MATERIAL_LIMITS.maxPdfPages) {
    return fail(
      'PDF_TOO_MANY_PAGES',
      `PDF 共 ${pages} 页，超过 ${MATERIAL_LIMITS.maxPdfPages} 页上限，请拆分后再导入`,
    );
  }
  return PASS;
}

/** 分块数：> 800 时停止切分（材料转 partial，不报错）。 */
export function checkChunkCount(count: number): LimitCheck {
  if (count <= MATERIAL_LIMITS.maxChunks) return PASS;
  return fail('CHUNK_LIMIT', `内容过长，仅处理前 ${MATERIAL_LIMITS.maxChunks} 个分块`);
}

/** 提取文本总量：≤ 8 MB 字符。 */
export function checkExtractedChars(chars: number): LimitCheck {
  if (chars <= MATERIAL_LIMITS.maxExtractedChars) return PASS;
  return fail('EXTRACTED_TOO_LARGE');
}

/** DOCX 解压体积上限：≤ 40 MB。 */
export function checkZipBytes(uncompressedBytes: number): LimitCheck {
  if (uncompressedBytes <= MATERIAL_LIMITS.maxZipBytes) return PASS;
  return fail('ARCHIVE_LIMIT', `压缩包解压后超过 ${formatBytesMb(MATERIAL_LIMITS.maxZipBytes)} 上限`);
}

/** DOCX 压缩比：≤ 120（zip bomb 防护）。 */
export function checkZipRatio(compressedBytes: number, uncompressedBytes: number): LimitCheck {
  if (!Number.isFinite(compressedBytes) || !Number.isFinite(uncompressedBytes)) {
    return fail('ARCHIVE_LIMIT', '压缩包大小信息异常');
  }
  if (compressedBytes <= 0) {
    // 空压缩包 / 元数据缺失：不做比值判断，交给解压体积与条目数兜底
    return uncompressedBytes > 0 ? fail('ARCHIVE_LIMIT', '压缩包大小信息异常') : PASS;
  }
  const ratio = uncompressedBytes / compressedBytes;
  if (ratio > MATERIAL_LIMITS.maxZipRatio) {
    return fail(
      'ARCHIVE_LIMIT',
      `压缩比 ${ratio.toFixed(1)} 超过 ${MATERIAL_LIMITS.maxZipRatio} 上限（疑似压缩炸弹）`,
    );
  }
  return PASS;
}

/** DOCX 中央目录条目数：≤ 512。 */
export function checkZipEntries(count: number): LimitCheck {
  if (count <= MATERIAL_LIMITS.maxZipEntries) return PASS;
  return fail('ARCHIVE_LIMIT', `压缩包条目数 ${count} 超过 ${MATERIAL_LIMITS.maxZipEntries} 上限`);
}

/** 粘贴摘录的字符数：≤ 200k。 */
export function checkPastedChars(chars: number): LimitCheck {
  if (chars === 0) return fail('EMPTY_FILE', '粘贴内容为空');
  if (chars > MATERIAL_LIMITS.maxPastedChars) {
    return fail('FILE_TOO_LARGE', `粘贴内容超过 ${MATERIAL_LIMITS.maxPastedChars} 字符上限`);
  }
  return PASS;
}

/** 把校验结果转成 `{ ok:false, … }` 之外的可读错误（供 Server Action 直接返回）。 */
export function limitErrorOf(check: LimitCheck): { code: string; message: string } | null {
  return check.ok ? null : { code: check.code, message: check.message };
}
