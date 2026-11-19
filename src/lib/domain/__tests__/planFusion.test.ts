/**
 * 被测文件：src/lib/domain/planFusion.ts
 * 规则来源：v2.2 §12（记录负担）与 gap analysis「预算档位映射证据级别」。
 */

import { describe, expect, it } from 'vitest';
import { evidenceHintForBudget } from '../planFusion';

describe('预算 → 证据记录级别', () => {
  it.each([
    [0, null],
    [15, null],
    [16, 'QUICK'],
    [59, 'QUICK'],
    [60, 'STANDARD'],
    [179, 'STANDARD'],
    [180, 'FULL'],
    [240, 'FULL'],
    [600, 'FULL'],
  ])('%i 分钟 → %s', (minutes, level) => {
    expect(evidenceHintForBudget(minutes as number).level).toBe(level);
  });

  it('每个区间都有非空建议，15 分钟以内明确不强制证据链', () => {
    for (const minutes of [0, 15, 30, 60, 120, 180, 240]) {
      const hint = evidenceHintForBudget(minutes);
      expect(hint.advice.length).toBeGreaterThan(10);
    }
    expect(evidenceHintForBudget(15).advice).toContain('不要求完整证据链');
    expect(evidenceHintForBudget(30).advice).toContain('Quick Evidence');
  });

  it('负数与非法值按维护模式处理', () => {
    expect(evidenceHintForBudget(-20).level).toBeNull();
    expect(evidenceHintForBudget(Number.NaN).level).toBeNull();
  });
});
