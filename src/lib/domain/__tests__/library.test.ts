import { describe, expect, it } from 'vitest';
import rawSeed from '../../librarySeed.json';
import {
  checkReadingLog,
  libraryProgress,
  readingLastReadAt,
  validateMethodologySeed,
  type MethodologySeedItem,
} from '../library';
import { LIBRARY_SEED_SIZE, LIBRARY_SUMMARY_MIN_CHARS } from '../../constants';

const seed = rawSeed as unknown as MethodologySeedItem[];

describe('validateMethodologySeed', () => {
  it('内置 16 条预设全部合法', () => {
    expect(seed).toHaveLength(LIBRARY_SEED_SIZE);
    expect(validateMethodologySeed(seed)).toEqual({ ok: true });
  });

  it('URL 全部为 https 且唯一', () => {
    const urls = seed.map((item) => item.url);
    expect(urls.every((url) => url.startsWith('https://'))).toBe(true);
    expect(new Set(urls).size).toBe(seed.length);
  });

  it('六个分类都有条目，且每条都有许可说明', () => {
    const categories = new Set(seed.map((item) => item.category));
    expect(categories.size).toBe(6);
    expect(seed.every((item) => item.licenseNote.trim().length > 0)).toBe(true);
  });

  it('重复 URL 会被拒绝', () => {
    const broken = [...seed.slice(0, LIBRARY_SEED_SIZE - 1), { ...seed[0]! }];
    const result = validateMethodologySeed(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.includes('链接重复'))).toBe(true);
  });

  it('分类不合法会被拒绝', () => {
    const broken = seed.map((item, index) =>
      index === 0 ? { ...item, category: '不存在' as MethodologySeedItem['category'] } : item,
    );
    const result = validateMethodologySeed(broken);
    expect(result.ok).toBe(false);
  });

  it('缺少许可说明会被拒绝', () => {
    const broken = seed.map((item, index) =>
      index === 0 ? { ...item, licenseNote: '  ' } : item,
    );
    const result = validateMethodologySeed(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.includes('许可说明'))).toBe(true);
  });
});

describe('checkReadingLog', () => {
  it('未开始与阅读中无内容要求', () => {
    expect(checkReadingLog({ status: 'NOT_STARTED', personalSummary: null, plannedAction: null, appliedEvidenceId: null }).ok).toBe(true);
    expect(checkReadingLog({ status: 'READING', personalSummary: null, plannedAction: null, appliedEvidenceId: null }).ok).toBe(true);
  });

  it('已写摘要要求达到最小字数（边界 19/20）', () => {
    const short = 'a'.repeat(LIBRARY_SUMMARY_MIN_CHARS - 1);
    const enough = 'a'.repeat(LIBRARY_SUMMARY_MIN_CHARS);
    expect(
      checkReadingLog({ status: 'SUMMARIZED', personalSummary: short, plannedAction: null, appliedEvidenceId: null }).ok,
    ).toBe(false);
    expect(
      checkReadingLog({ status: 'SUMMARIZED', personalSummary: enough, plannedAction: null, appliedEvidenceId: null }).ok,
    ).toBe(true);
  });

  it('已实践要求摘要 + 实际动作', () => {
    const summary = '我用自己的话总结了这篇方法论的三个步骤，并标出了可以立刻使用的一条。';
    expect(
      checkReadingLog({ status: 'APPLIED', personalSummary: summary, plannedAction: '', appliedEvidenceId: null }).ok,
    ).toBe(false);
    expect(
      checkReadingLog({ status: 'APPLIED', personalSummary: summary, plannedAction: '复述一段 1 分钟音频', appliedEvidenceId: null }).ok,
    ).toBe(true);
  });

  it('已完成必须填写实践计划（收藏/打开不算掌握）', () => {
    expect(
      checkReadingLog({ status: 'DONE', personalSummary: '', plannedAction: '  ', appliedEvidenceId: 'ev1' }).ok,
    ).toBe(false);
    expect(
      checkReadingLog({ status: 'DONE', personalSummary: '', plannedAction: '完成 3 次写作复盘', appliedEvidenceId: null }).ok,
    ).toBe(true);
  });

  it('错误文案明确指向所缺内容', () => {
    const result = checkReadingLog({ status: 'APPLIED', personalSummary: '够长的个人摘要内容写在这里，并且超过了二十个字的门槛', plannedAction: '', appliedEvidenceId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('实际做了什么练习');
  });
});

describe('readingLastReadAt', () => {
  it('未开始清空，其余记录业务日', () => {
    expect(readingLastReadAt('NOT_STARTED', '2026-11-19')).toBeNull();
    expect(readingLastReadAt('READING', '2026-11-19')).toBe('2026-11-19');
    expect(readingLastReadAt('DONE', '2026-11-19')).toBe('2026-11-19');
  });
});

describe('libraryProgress', () => {
  it('按优先级统计总数/已开始/已完成', () => {
    const rows = [
      { priority: 'P0' as const, readingStatus: 'DONE' as const },
      { priority: 'P0' as const, readingStatus: 'READING' as const },
      { priority: 'P1' as const, readingStatus: 'SUMMARIZED' as const },
      { priority: 'P1' as const, readingStatus: null },
      { priority: 'P2' as const, readingStatus: 'APPLIED' as const },
      { priority: 'P2' as const, readingStatus: 'NOT_STARTED' as const },
    ];
    const stats = libraryProgress(rows);
    expect(stats).toMatchObject({ total: 6, started: 4, summarized: 3, applied: 2, done: 1 });
    expect(stats.byPriority.P0).toEqual({ total: 2, started: 2, done: 1 });
    expect(stats.byPriority.P1).toEqual({ total: 2, started: 1, done: 0 });
    expect(stats.byPriority.P2).toEqual({ total: 2, started: 1, done: 0 });
  });
});
