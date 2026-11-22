/**
 * 零依赖 ZIP 读取器单测（T05 验收：压缩炸弹/条目数/体积/路径四种防护）。
 *
 * 所有归档都由 `fixtures.buildZip` 现场生成：既能造出「声明解压 41MB 实际只有
 * 几十字节」的样本，也不需要往仓库里塞二进制。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_LIMITS } from '@/lib/constants';
import {
  ZipError,
  isZip,
  listZipEntryNames,
  readZipEntryByName,
  readZipIndex,
} from '../zip';
import { buildZip } from './fixtures';

function expectZipError(run: () => unknown, code: string): ZipError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ZipError);
    expect((error as ZipError).code).toBe(code);
    return error as ZipError;
  }
  throw new Error(`期望抛出 ZipError(${code})，但没有抛错`);
}

describe('zip：正常读取', () => {
  it('isZip 只认本地文件头魔数', () => {
    expect(isZip(buildZip([{ name: 'a.txt', content: 'x' }]))).toBe(true);
    expect(isZip(Buffer.from('PK', 'utf8'))).toBe(false);
    expect(isZip(Buffer.alloc(0))).toBe(false);
  });

  it('中央目录能读出条目名、压缩方式与体积', () => {
    const bytes = buildZip([
      { name: 'store.txt', content: 'hello', method: 0 },
      { name: 'deflate.txt', content: 'world' },
    ]);
    const index = readZipIndex(bytes);
    expect(index.entries.map((entry) => entry.name)).toEqual(['store.txt', 'deflate.txt']);
    expect(index.entries[0].method).toBe(0);
    expect(index.entries[1].method).toBe(8);
    expect(index.uncompressedTotal).toBe(10);
    expect(index.compressedTotal).toBeGreaterThan(0);
  });

  it('listZipEntryNames 对垃圾数据返回 null（嗅探路径不抛错）', () => {
    expect(listZipEntryNames(Buffer.from('not a zip'))).toBeNull();
    expect(listZipEntryNames(buildZip([{ name: 'x.txt', content: 'x' }]))).toEqual(['x.txt']);
  });
});

describe('zip：压缩炸弹与体积防护', () => {
  it('压缩比超过 120 → ARCHIVE_LIMIT', () => {
    const bytes = buildZip([{ name: 'bomb.txt', content: 'b'.repeat(50_000) }]);
    const error = expectZipError(() => readZipIndex(bytes), 'ARCHIVE_LIMIT');
    expect(error.message).toContain('压缩比');
  });

  it('解压后总量超过 40MB → ARCHIVE_LIMIT', () => {
    const bytes = buildZip([
      {
        name: 'huge.txt',
        content: 'tiny',
        declaredUncompressedSize: MATERIAL_LIMITS.maxZipBytes + 1,
      },
    ]);
    const error = expectZipError(() => readZipIndex(bytes), 'ARCHIVE_LIMIT');
    expect(error.message).toContain('解压后超过上限');
  });

  it('条目数超过 512 → ARCHIVE_LIMIT', () => {
    const entries = Array.from({ length: MATERIAL_LIMITS.maxZipEntries + 1 }, (_, index) => ({
      name: `e${index}.txt`,
      content: 'x',
    }));
    const bytes = buildZip(entries);
    const error = expectZipError(() => readZipIndex(bytes), 'ARCHIVE_LIMIT');
    expect(error.message).toContain('条目数');
  });

  it('声明长度与实际解压长度不一致 → INVALID_ARCHIVE（不信元数据）', () => {
    const bytes = buildZip([{ name: 'a.txt', content: 'x'.repeat(10), declaredUncompressedSize: 30 }]);
    const index = readZipIndex(bytes);
    expectZipError(() => readZipEntryByName(bytes, 'a.txt'), 'INVALID_ARCHIVE');
    // 索引层能过（比值正常），问题在解压后的实测长度
    expect(index.entries[0].uncompressedSize).toBe(30);
  });
});

describe('zip：非法归档', () => {
  it('目录穿越条目 → INVALID_ARCHIVE', () => {
    const bytes = buildZip([{ name: '../../etc/passwd', content: 'x' }]);
    const error = expectZipError(() => readZipIndex(bytes), 'INVALID_ARCHIVE');
    expect(error.message).toContain('目录穿越');
  });

  it('绝对路径条目 → INVALID_ARCHIVE', () => {
    expectZipError(
      () => readZipIndex(buildZip([{ name: '/etc/passwd', content: 'x' }])),
      'INVALID_ARCHIVE',
    );
    expectZipError(
      () => readZipIndex(buildZip([{ name: 'C:\\Windows\\win.ini', content: 'x' }])),
      'INVALID_ARCHIVE',
    );
  });

  it('非 ZIP 数据 → INVALID_ARCHIVE', () => {
    expectZipError(() => readZipIndex(Buffer.from('plain text body')), 'INVALID_ARCHIVE');
  });

  it('EOCD 被截断 → INVALID_ARCHIVE（不越界读）', () => {
    const bytes = buildZip([{ name: 'a.txt', content: 'hello world' }]);
    const truncated = bytes.subarray(0, bytes.length - 10);
    const error = expectZipError(() => readZipIndex(truncated), 'INVALID_ARCHIVE');
    expect(error.message).toContain('中央目录');
  });

  it('条目名不是合法 UTF-8 之外的脏名字也拒绝（NUL）', () => {
    const bytes = buildZip([{ name: 'bad\0name.txt', content: 'x' }]);
    expectZipError(() => readZipIndex(bytes), 'INVALID_ARCHIVE');
  });
});
