/**
 * 资源限制纯函数单测（架构 §5）：每个阈值都断言「刚好等于上限通过、+1 拒绝」，
 * 这样任何人改动常量都会立刻发现边界漂移。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_LIMITS } from '@/lib/constants';
import {
  checkChunkCount,
  checkExtractedChars,
  checkFileSize,
  checkPastedChars,
  checkPdfPages,
  checkZipBytes,
  checkZipEntries,
  checkZipRatio,
  formatBytesMb,
  limitErrorOf,
} from '../limits';

describe('checkFileSize', () => {
  it('0 字节 → EMPTY_FILE', () => {
    expect(checkFileSize(0)).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
  });

  it('负数/NaN → EMPTY_FILE（不当作正常文件）', () => {
    expect(checkFileSize(-1)).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
    expect(checkFileSize(Number.NaN)).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
  });

  it('恰好 20MB 通过，+1 字节拒绝', () => {
    expect(checkFileSize(MATERIAL_LIMITS.maxFileBytes)).toEqual({ ok: true });
    const over = checkFileSize(MATERIAL_LIMITS.maxFileBytes + 1);
    expect(over).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
    if (!over.ok) expect(over.message).toContain('20MB');
  });
});

describe('checkPdfPages', () => {
  it('200 页通过，201 页拒绝且提示拆分', () => {
    expect(checkPdfPages(MATERIAL_LIMITS.maxPdfPages)).toEqual({ ok: true });
    const over = checkPdfPages(MATERIAL_LIMITS.maxPdfPages + 1);
    expect(over).toMatchObject({ ok: false, code: 'PDF_TOO_MANY_PAGES' });
    if (!over.ok) expect(over.message).toContain('拆分');
  });

  it('0 页 → NO_TEXT', () => {
    expect(checkPdfPages(0)).toMatchObject({ ok: false, code: 'NO_TEXT' });
    expect(checkPdfPages(Number.NaN)).toMatchObject({ ok: false, code: 'NO_TEXT' });
  });
});

describe('checkChunkCount', () => {
  it('800 通过，801 拒绝（CHUNK_LIMIT）', () => {
    expect(checkChunkCount(MATERIAL_LIMITS.maxChunks)).toEqual({ ok: true });
    expect(checkChunkCount(MATERIAL_LIMITS.maxChunks + 1)).toMatchObject({
      ok: false,
      code: 'CHUNK_LIMIT',
    });
  });
});

describe('checkExtractedChars', () => {
  it('8MB 字符通过，+1 拒绝（EXTRACTED_TOO_LARGE）', () => {
    expect(checkExtractedChars(MATERIAL_LIMITS.maxExtractedChars)).toEqual({ ok: true });
    expect(checkExtractedChars(MATERIAL_LIMITS.maxExtractedChars + 1)).toMatchObject({
      ok: false,
      code: 'EXTRACTED_TOO_LARGE',
    });
  });
});

describe('checkZipBytes / checkZipRatio / checkZipEntries', () => {
  it('解压总量 40MB 通过，+1 拒绝', () => {
    expect(checkZipBytes(MATERIAL_LIMITS.maxZipBytes)).toEqual({ ok: true });
    expect(checkZipBytes(MATERIAL_LIMITS.maxZipBytes + 1)).toMatchObject({
      ok: false,
      code: 'ARCHIVE_LIMIT',
    });
  });

  it('压缩比 120 通过，121 拒绝', () => {
    expect(checkZipRatio(1000, 120_000)).toEqual({ ok: true });
    const over = checkZipRatio(1000, 121_000);
    expect(over).toMatchObject({ ok: false, code: 'ARCHIVE_LIMIT' });
    if (!over.ok) expect(over.message).toContain('疑似压缩炸弹');
  });

  it('压缩大小为 0 但解压大小 >0 → 视为元数据异常', () => {
    expect(checkZipRatio(0, 0)).toEqual({ ok: true });
    expect(checkZipRatio(0, 100)).toMatchObject({ ok: false, code: 'ARCHIVE_LIMIT' });
  });

  it('条目数 512 通过，513 拒绝', () => {
    expect(checkZipEntries(MATERIAL_LIMITS.maxZipEntries)).toEqual({ ok: true });
    expect(checkZipEntries(MATERIAL_LIMITS.maxZipEntries + 1)).toMatchObject({
      ok: false,
      code: 'ARCHIVE_LIMIT',
    });
  });
});

describe('checkPastedChars', () => {
  it('0 字符 → EMPTY_FILE', () => {
    expect(checkPastedChars(0)).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
  });

  it('200k 通过，200001 拒绝', () => {
    expect(checkPastedChars(MATERIAL_LIMITS.maxPastedChars)).toEqual({ ok: true });
    expect(checkPastedChars(MATERIAL_LIMITS.maxPastedChars + 1)).toMatchObject({
      ok: false,
      code: 'FILE_TOO_LARGE',
    });
  });
});

describe('辅助函数', () => {
  it('formatBytesMb 保留一位小数、整数值不带小数', () => {
    expect(formatBytesMb(20 * 1024 * 1024)).toBe('20MB');
    expect(formatBytesMb(1.5 * 1024 * 1024)).toBe('1.5MB');
  });

  it('limitErrorOf 把通过转成 null、失败转成可读错误', () => {
    expect(limitErrorOf({ ok: true })).toBeNull();
    const error = limitErrorOf(checkFileSize(0));
    expect(error).not.toBeNull();
    expect(error?.code).toBe('EMPTY_FILE');
    expect(typeof error?.message).toBe('string');
  });
});
