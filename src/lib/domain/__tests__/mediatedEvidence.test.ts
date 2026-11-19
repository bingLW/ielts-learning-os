import { describe, expect, it } from 'vitest';
import {
  buildMediatedEvidenceDraft,
  checkMediatedEvidenceUniqueness,
  mediatedEvidenceAssistance,
  mediatedEvidenceLevel,
  mediatedEvidenceOutput,
} from '../mediatedEvidence';
import { MEDIATED_SUMMARY_MIN_CHARS } from '../../constants';
import type { MediatedEvidenceSource } from '../mediatedEvidence';

const base: MediatedEvidenceSource = {
  subject: 'French',
  topic: 'French present tense',
  sourceTitle: 'Coffee Break French S1E03',
  sourceUrl: 'https://example.com/cbf-03',
  primarySkill: 'LISTENING',
  translationDependency: 'NONE',
  notesEn: 'je parle / tu parles / il parle',
  summaryEn: 'This episode explains how regular -er verbs change in the present tense and gives three spoken examples.',
  questionsEn: 'Why does the ending change for nous?',
};

describe('mediatedEvidenceAssistance', () => {
  it('只有 NONE 是 A0，其余按依赖程度升到 A1–A3', () => {
    expect(mediatedEvidenceAssistance('NONE')).toBe('A0');
    expect(mediatedEvidenceAssistance('SUBTITLE_EN')).toBe('A1');
    expect(mediatedEvidenceAssistance('ZH_ASSIST')).toBe('A2');
    expect(mediatedEvidenceAssistance('HEAVY_ZH')).toBe('A3');
  });
});

describe('mediatedEvidenceLevel', () => {
  it('摘要达到 40 字记 Standard，不足记 Quick', () => {
    expect(mediatedEvidenceLevel('a'.repeat(MEDIATED_SUMMARY_MIN_CHARS))).toBe('STANDARD');
    expect(mediatedEvidenceLevel('a'.repeat(MEDIATED_SUMMARY_MIN_CHARS - 1))).toBe('QUICK');
    expect(mediatedEvidenceLevel(null)).toBe('QUICK');
    expect(mediatedEvidenceLevel('   ')).toBe('QUICK');
  });
});

describe('mediatedEvidenceOutput', () => {
  it('优先摘要，其次笔记，最后问题', () => {
    expect(mediatedEvidenceOutput(base)).toBe(base.summaryEn);
    expect(mediatedEvidenceOutput({ ...base, summaryEn: null })).toBe(base.notesEn);
    expect(mediatedEvidenceOutput({ ...base, summaryEn: '  ', notesEn: null })).toBe(
      base.questionsEn,
    );
  });

  it('三类产出全空时返回 null', () => {
    expect(
      mediatedEvidenceOutput({ ...base, summaryEn: null, notesEn: null, questionsEn: null }),
    ).toBeNull();
  });
});

describe('buildMediatedEvidenceDraft', () => {
  it('生成应用类证据，只带主技能，辅助级别与材料来源齐全', () => {
    const built = buildMediatedEvidenceDraft(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.draft.skill).toBe('LISTENING');
    expect(built.draft.evidenceType).toBe('APPLIED_TASK');
    expect(built.draft.level).toBe('STANDARD');
    expect(built.draft.assistanceLevel).toBe('A0');
    expect(built.draft.prompt).toBe('French · French present tense');
    expect(built.draft.materialSource).toContain('Coffee Break French S1E03');
    expect(built.draft.materialSource).toContain('https://example.com/cbf-03');
    expect(built.draft.note).toContain('仅计入 LISTENING');
  });

  it('短摘要或无产出分别降级与拒绝', () => {
    const short = buildMediatedEvidenceDraft({ ...base, summaryEn: 'short' });
    if (!short.ok) throw new Error('expected ok');
    expect(short.draft.level).toBe('QUICK');
    expect(short.draft.assistanceLevel).toBe('A0');

    const empty = buildMediatedEvidenceDraft({
      ...base,
      summaryEn: null,
      notesEn: null,
      questionsEn: null,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('没有英文笔记');
  });

  it('FOUNDATION 主技能不能生成证据', () => {
    const built = buildMediatedEvidenceDraft({ ...base, primarySkill: 'FOUNDATION' });
    expect(built.ok).toBe(false);
  });

  it('没有材料标题/链接时 materialSource 为 null', () => {
    const built = buildMediatedEvidenceDraft({ ...base, sourceTitle: null, sourceUrl: null });
    if (!built.ok) throw new Error('expected ok');
    expect(built.draft.materialSource).toBeNull();
  });
});

describe('checkMediatedEvidenceUniqueness', () => {
  it('已存在活动证据时拒绝重复生成', () => {
    expect(checkMediatedEvidenceUniqueness(0).ok).toBe(true);
    const gate = checkMediatedEvidenceUniqueness(1);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('不能重复生成');
  });
});
