/**
 * 被测文件：src/lib/domain/profile.ts
 * 规则来源：v2.2 §4（分项画像）—— 置信度由证据结构决定，不取四项平均。
 */

import { describe, expect, it } from 'vitest';
import { profileReviewDueDate, suggestProfileConfidence } from '../profile';
import { addDays } from '../../date';

describe('suggestProfileConfidence', () => {
  it('没有任何证据 → LOW，并列出缺口', () => {
    const result = suggestProfileConfidence([]);
    expect(result.confidence).toBe('LOW');
    expect(result.gaps).toContain('还没有无辅助基线（E0）');
    expect(result.gaps).toContain('还没有独立的即时/延迟复测（E2/E3）');
  });

  it('基线不是 A0 → LOW', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A2' },
    ]);
    expect(result.confidence).toBe('LOW');
    expect(result.gaps).toContain('基线不是 A0 无辅助样本');
  });

  it('只有 A0 基线、没有独立复测 → LOW', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A0' },
      { evidenceType: 'ASSISTED', assistanceLevel: 'A3' },
    ]);
    expect(result.confidence).toBe('LOW');
    expect(result.gaps).toContain('还没有独立的即时/延迟复测（E2/E3）');
  });

  it('基线 + 独立即时复测 → MEDIUM', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A0' },
      { evidenceType: 'IMMEDIATE_RETEST', assistanceLevel: 'A0' },
    ]);
    expect(result.confidence).toBe('MEDIUM');
    expect(result.gaps).toContain('还没有独立完成的实际应用或迁移证据（E4/E5）');
  });

  it('辅助复测不算独立复测', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A0' },
      { evidenceType: 'IMMEDIATE_RETEST', assistanceLevel: 'A3' },
    ]);
    expect(result.confidence).toBe('LOW');
  });

  it('基线 + 独立延迟复测 + 独立迁移 → HIGH，无缺口', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A0' },
      { evidenceType: 'DELAYED_RETEST', assistanceLevel: 'A0' },
      { evidenceType: 'TRANSFER', assistanceLevel: 'A0' },
    ]);
    expect(result.confidence).toBe('HIGH');
    expect(result.gaps).toEqual([]);
  });

  it('独立延迟复测 + 独立实际应用也算 HIGH', () => {
    const result = suggestProfileConfidence([
      { evidenceType: 'BASELINE', assistanceLevel: 'A0' },
      { evidenceType: 'DELAYED_RETEST', assistanceLevel: 'A0' },
      { evidenceType: 'APPLIED_TASK', assistanceLevel: 'A0' },
    ]);
    expect(result.confidence).toBe('HIGH');
  });
});

describe('profileReviewDueDate', () => {
  it('按置信度给出 14/30/90 天复评间隔', () => {
    expect(profileReviewDueDate('LOW', addDays, '2026-11-19')).toBe('2026-12-03');
    expect(profileReviewDueDate('MEDIUM', addDays, '2026-11-19')).toBe('2026-12-19');
    expect(profileReviewDueDate('HIGH', addDays, '2026-11-19')).toBe('2027-02-17');
  });
});
