/**
 * 状态机单测（T08 验收：合法/非法转移）。
 *
 * 断言口径直接对照 `docs/31-v2.6-state-machine.mermaid`：
 * 图里的每条边必须为 true，图里没有的边必须为 false —— 这样「手滑多加一条
 * 合法边」或「误删一条」都会立刻被抓到。
 */

import { describe, expect, it } from 'vitest';
import { MATERIAL_STATUSES, type MaterialStatus } from '@/lib/constants';
import {
  MATERIAL_TERMINAL_STATUSES,
  MATERIAL_TRANSITIONS,
  STAGE_TO_STATUS,
  canTransition,
  assertTransition,
  isCancellable,
  isProcessingStatus,
  isRetryable,
  isTerminal,
  nextStage,
} from '../stateMachine';

/** 图里的全部边（逐条抄自 mermaid）。 */
const MERMAID_EDGES: Array<[MaterialStatus, MaterialStatus]> = [
  ['created', 'validating'],
  ['validating', 'extracting'],
  ['validating', 'failed'],
  ['extracting', 'normalizing'],
  ['extracting', 'failed'],
  ['extracting', 'partial'],
  ['normalizing', 'analyzing'],
  ['normalizing', 'failed'],
  ['analyzing', 'generating'],
  ['analyzing', 'partial'],
  ['analyzing', 'failed'],
  ['analyzing', 'review_required'],
  ['generating', 'review_required'],
  ['generating', 'partial'],
  ['generating', 'failed'],
  ['review_required', 'ready'],
  ['review_required', 'partial'],
  ['created', 'cancelled'],
  ['validating', 'cancelled'],
  ['extracting', 'cancelled'],
  ['normalizing', 'cancelled'],
  ['analyzing', 'cancelled'],
  ['generating', 'cancelled'],
  ['failed', 'created'],
  ['partial', 'analyzing'],
];

describe('状态机：合法转移', () => {
  it('状态机图里的每条边都被允许', () => {
    for (const [from, to] of MERMAID_EDGES) {
      expect(canTransition(from, to), `${from} → ${to} 应当合法`).toBe(true);
    }
  });

  it('架构 §5 补充的 normalizing → partial（chunk 超 800 停切）', () => {
    expect(canTransition('normalizing', 'partial')).toBe(true);
  });
});

describe('状态机：非法转移', () => {
  it('不允许跳阶段', () => {
    expect(canTransition('created', 'extracting')).toBe(false);
    expect(canTransition('created', 'normalizing')).toBe(false);
    expect(canTransition('validating', 'normalizing')).toBe(false);
    expect(canTransition('extracting', 'analyzing')).toBe(false);
    expect(canTransition('normalizing', 'generating')).toBe(false);
  });

  it('终态不能再被自动推进（ready / cancelled 无出边）', () => {
    expect(MATERIAL_TRANSITIONS.ready).toEqual([]);
    expect(MATERIAL_TRANSITIONS.cancelled).toEqual([]);
    for (const to of MATERIAL_STATUSES) {
      expect(canTransition('ready', to)).toBe(false);
      expect(canTransition('cancelled', to)).toBe(false);
    }
  });

  it('partial 只能「继续分析」，不能重试或取消', () => {
    expect(canTransition('partial', 'analyzing')).toBe(true);
    expect(canTransition('partial', 'created')).toBe(false);
    expect(canTransition('partial', 'cancelled')).toBe(false);
  });

  it('失败只能重试回 created，不能直接跳到任何处理阶段', () => {
    expect(canTransition('failed', 'created')).toBe(true);
    expect(canTransition('failed', 'validating')).toBe(false);
    expect(canTransition('failed', 'extracting')).toBe(false);
  });

  it('assertTransition 对非法边抛错并列出允许值', () => {
    expect(() => assertTransition('created', 'ready')).toThrowError(/非法状态转移/);
    expect(() => assertTransition('created', 'validating')).not.toThrow();
  });
});

describe('状态机：T11 新增 review_required → generating（用户手动触发）', () => {
  it('允许从「待你审核」手动发起练习生成', () => {
    expect(canTransition('review_required', 'generating')).toBe(true);
    expect(MATERIAL_TRANSITIONS.review_required).toContain('generating');
  });

  it('待审核的出边被锁死为三条：ready / partial / generating', () => {
    // 加边必须改这张断言，避免"手滑多一条自动边"让 tick 绕过人的裁决
    expect([...MATERIAL_TRANSITIONS.review_required]).toEqual(['ready', 'partial', 'generating']);
  });

  it('不允许从别的终态挤进 generating', () => {
    expect(canTransition('generating', 'analyzing')).toBe(false);
    expect(canTransition('ready', 'generating')).toBe(false);
    expect(canTransition('partial', 'generating')).toBe(false);
    expect(canTransition('failed', 'generating')).toBe(false);
    expect(canTransition('created', 'generating')).toBe(false);
  });

  it('待审核不因此变成「处理中」或「可取消」：tick 仍然停手', () => {
    expect(isProcessingStatus('review_required')).toBe(false);
    expect(isCancellable('review_required')).toBe(false);
  });
});

describe('状态机：派生判定', () => {
  it('终态集合与处理中集合互补', () => {
    expect([...MATERIAL_TERMINAL_STATUSES].sort()).toEqual(
      ['ready', 'partial', 'failed', 'cancelled'].sort(),
    );
    for (const status of MATERIAL_STATUSES) {
      if (isTerminal(status)) expect(isProcessingStatus(status)).toBe(false);
    }
    // created 也算「处理中」：第一个 tick 就要跑校验，UI 必须轮询
    expect(isProcessingStatus('created')).toBe(true);
    expect(isProcessingStatus('extracting')).toBe(true);
    expect(isProcessingStatus('review_required')).toBe(false);
  });

  it('可取消 / 可重试', () => {
    expect(isCancellable('created')).toBe(true);
    expect(isCancellable('analyzing')).toBe(true);
    expect(isCancellable('review_required')).toBe(false);
    expect(isCancellable('partial')).toBe(false);
    expect(isRetryable('failed')).toBe(true);
    expect(isRetryable('partial')).toBe(false);
  });

  it('阶段与状态一一对应，且阶段顺序单调', () => {
    expect(STAGE_TO_STATUS.validating).toBe('extracting');
    expect(STAGE_TO_STATUS.normalizing).toBe('analyzing');
    expect(nextStage('validating')).toBe('extracting');
    expect(nextStage('normalizing')).toBe('analyzing');
    expect(nextStage('generating')).toBeNull();
  });
});
