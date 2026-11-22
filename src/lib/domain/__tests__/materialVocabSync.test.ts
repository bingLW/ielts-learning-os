/**
 * `decideSync` 的四条规则（T12 §4）。
 *
 * 这个纯函数决定「这个候选进主库还是只加来源」。它错了不会报错，只会造成两种
 * 不可逆的损坏：① 把人工润色过的释义覆盖成 AI 释义；② 词库里长出重复词条。
 * 所以四条规则要**逐条**断言，顺序也要单独断言（顺序即语义）。
 */

import { describe, expect, it } from 'vitest';
import { decideSync, SYNC_ALLOWED_REVIEW_STATUSES } from '../materialVocabSync';

const LIBRARY: { id: string; sourceCount: number } = { id: 'item-1', sourceCount: 2 };

describe('decideSync 规则 ①：只有人确认过的词才允许进主库', () => {
  it('accepted / edited → 放行（词库没有就 create）', () => {
    expect(
      decideSync({ candidateReviewStatus: 'accepted', syncStatus: 'pending', libraryItem: null })
        .action,
    ).toBe('create');
    expect(
      decideSync({ candidateReviewStatus: 'edited', syncStatus: 'pending', libraryItem: null })
        .action,
    ).toBe('create');
    expect(SYNC_ALLOWED_REVIEW_STATUSES).toEqual(['accepted', 'edited']);
  });

  it('draft / rejected → skip（无论词库有没有）', () => {
    for (const status of ['draft', 'rejected']) {
      const decision = decideSync({
        candidateReviewStatus: status,
        syncStatus: 'pending',
        libraryItem: null,
      });
      expect(decision.action, status).toBe('skip');
      expect(decision.reasonZh, status).toContain('尚未被采纳');
    }
    // 词库已有该词时也不许"顺手加个来源"—— 未确认的词不该出现在任何词条的历史里
    expect(
      decideSync({ candidateReviewStatus: 'draft', syncStatus: 'pending', libraryItem: LIBRARY })
        .action,
    ).toBe('skip');
  });

  it('顺序：规则 ① 在规则 ②③ 之前（draft + 词库没有 → skip 而不是 create）', () => {
    // 这条是顺序断言：如果哪天有人把"词库没有就建"提前，会因为这条用例变红
    const decision = decideSync({
      candidateReviewStatus: 'draft',
      syncStatus: 'pending',
      libraryItem: null,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reasonZh).not.toContain('新建');
  });

  it('大小写/空白容错：` Accepted ` 仍按已采纳处理', () => {
    expect(
      decideSync({ candidateReviewStatus: ' Accepted ', syncStatus: 'pending', libraryItem: null })
        .action,
    ).toBe('create');
  });

  it('未知审核状态一律 skip（fail-closed）', () => {
    for (const status of ['', '   ', 'pending', 'APPROVED', 'needs_review', '[object Object]']) {
      expect(
        decideSync({ candidateReviewStatus: status, syncStatus: 'pending', libraryItem: null })
          .action,
        status,
      ).toBe('skip');
    }
  });
});

describe('decideSync 规则 ②：已同步过就跳过（幂等）', () => {
  it('synced → skip，且不会因为词库恰好没有就重建', () => {
    const decision = decideSync({
      candidateReviewStatus: 'accepted',
      syncStatus: 'synced',
      libraryItem: null,
    });
    expect(decision.action).toBe('skip');
    expect(decision.reasonZh).toContain('已经同步过');
  });

  it('synced + 词库已有 → 也 skip（不会重复加来源）', () => {
    expect(
      decideSync({
        candidateReviewStatus: 'accepted',
        syncStatus: 'synced',
        libraryItem: LIBRARY,
      }).action,
    ).toBe('skip');
  });

  it('pending / failed / skipped 都可以继续走（failed 是 E-06 的可重试入口）', () => {
    for (const syncStatus of ['pending', 'failed', 'skipped']) {
      expect(
        decideSync({ candidateReviewStatus: 'accepted', syncStatus, libraryItem: null }).action,
        syncStatus,
      ).toBe('create');
    }
  });
});

describe('decideSync 规则 ③④：词库没有就建、有就只加来源', () => {
  it('libraryItem === null → create', () => {
    const decision = decideSync({
      candidateReviewStatus: 'accepted',
      syncStatus: 'pending',
      libraryItem: null,
    });
    expect(decision.action).toBe('create');
    expect(decision.reasonZh).toContain('新建词条');
  });

  it('libraryItem !== null → add_source（绝不 create）', () => {
    const decision = decideSync({
      candidateReviewStatus: 'accepted',
      syncStatus: 'pending',
      libraryItem: LIBRARY,
    });
    expect(decision.action).toBe('add_source');
    // 文案必须让用户看出「不会覆盖已有释义」
    expect(decision.reasonZh).toContain('只追加');
    expect(decision.reasonZh).toContain('不改动已有释义');
    expect(decision.reasonZh).toContain('2 个来源');
  });

  it('已有词条但来源数为 0（历史脏数据）也给 add_source，不崩不 create', () => {
    const decision = decideSync({
      candidateReviewStatus: 'edited',
      syncStatus: 'pending',
      libraryItem: { id: 'item-2', sourceCount: 0 },
    });
    expect(decision.action).toBe('add_source');
    expect(decision.reasonZh).not.toContain('0 个来源');
  });

  it('来源数是 NaN/负数时不炸（防御性）', () => {
    for (const count of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const decision = decideSync({
        candidateReviewStatus: 'accepted',
        syncStatus: 'pending',
        libraryItem: { id: 'item-3', sourceCount: count },
      });
      expect(decision.action).toBe('add_source');
      expect(decision.reasonZh.length).toBeGreaterThan(0);
    }
  });
});

describe('decideSync 组合：四规则的所有可达分支', () => {
  it('(review × syncStatus × library) 的全组合里，只有 4 种输入会写主库', () => {
    const reviews = ['draft', 'accepted', 'edited', 'rejected', 'unknown'];
    const syncStatuses = ['pending', 'synced', 'failed', 'skipped'];
    const libraries = [null, LIBRARY];

    const writes = new Map<string, number>();
    for (const review of reviews) {
      for (const syncStatus of syncStatuses) {
        for (const libraryItem of libraries) {
          const action = decideSync({
            candidateReviewStatus: review,
            syncStatus,
            libraryItem,
          }).action;
          if (action === 'skip') continue;
          const key = `${action}`;
          writes.set(key, (writes.get(key) ?? 0) + 1);
          // 所有"会写主库"的组合都必须是通过审核 + 未同步过
          expect(['accepted', 'edited']).toContain(review);
          expect(syncStatus).not.toBe('synced');
        }
      }
    }

    // accepted/edited × pending,failed,skipped × {null, LIBRARY} = 2 × 3 × 2 = 12 种
    expect((writes.get('create') ?? 0) + (writes.get('add_source') ?? 0)).toBe(12);
    expect(writes.get('create')).toBe(6);
    expect(writes.get('add_source')).toBe(6);
  });
});
