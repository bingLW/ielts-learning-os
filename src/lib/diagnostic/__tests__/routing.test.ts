import { describe, expect, it } from 'vitest';
import {
  buildReportDraft,
  decideNextObjectiveItem,
  estimateSkillProfile,
  levelBelow,
  scoreObjectiveItem,
  type SkillSample,
  type SkillProfileDraft,
} from '@/lib/diagnostic/routing';
import { validateBankSeeds, DIAGNOSTIC_ITEM_SEEDS, pickInitialItemCodes } from '@/lib/diagnostic/bank';
import { buildPlanDraft } from '@/lib/diagnostic/plan';

const mcq = { taskType: 'MCQ', correctAnswer: 'B', optionsJson: JSON.stringify([
  { key: 'A', text: '5 点' },
  { key: 'B', text: '6 点' },
  { key: 'C', text: '7 点' },
  { key: 'D', text: '8 点' },
]) };

describe('客观题确定性判分', () => {
  it('接受选项字母并忽略大小写', () => {
    expect(scoreObjectiveItem(mcq, 'b')).toEqual({ score: 2, maxScore: 2, correct: true });
    expect(scoreObjectiveItem(mcq, 'A')).toEqual({ score: 0, maxScore: 2, correct: false });
  });

  it('接受选项文本（忽略标点与空格）', () => {
    expect(scoreObjectiveItem(mcq, '6 点')?.correct).toBe(true);
    expect(scoreObjectiveItem(mcq, '  6点 ')?.correct).toBe(false);
  });

  it('填空题忽略大小写与首尾空白', () => {
    const item = { taskType: 'SHORT_ANSWER', correctAnswer: 'growth', optionsJson: null };
    expect(scoreObjectiveItem(item, ' GROWTH ')?.correct).toBe(true);
    expect(scoreObjectiveItem(item, 'grow')?.correct).toBe(false);
  });

  it('开放任务不由确定性逻辑判分', () => {
    expect(scoreObjectiveItem({ taskType: 'OPEN_TASK', correctAnswer: null, optionsJson: null }, 'x')).toBeNull();
  });

  it('空作答判 0 而不是异常', () => {
    expect(scoreObjectiveItem(mcq, '')).toEqual({ score: 0, maxScore: 2, correct: false });
  });
});

describe('难度路由', () => {
  const items = [
    { id: 'l1', itemCode: 'L1', skill: 'LISTENING', difficulty: 1, sourceType: 'VERIFIED', active: true },
    { id: 'l2', itemCode: 'L2', skill: 'LISTENING', difficulty: 2, sourceType: 'VERIFIED', active: true },
    { id: 'l3', itemCode: 'L3', skill: 'LISTENING', difficulty: 3, sourceType: 'VERIFIED', active: true },
    { id: 'l4', itemCode: 'L4', skill: 'LISTENING', difficulty: 4, sourceType: 'VERIFIED', active: true },
    { id: 'p1', itemCode: 'P1', skill: 'LISTENING', difficulty: 4, sourceType: 'AI_PRACTICE', active: true },
  ];

  it('答对升一档，并排除已见题目', () => {
    const decision = decideNextObjectiveItem({
      items,
      skill: 'LISTENING',
      attemptedCount: 1,
      lastDifficulty: 2,
      lastCorrect: true,
      seenItemIds: ['l2'],
    });
    expect(decision.targetDifficulty).toBe(3);
    expect(decision.itemId).toBe('l3');
  });

  it('答错降一档', () => {
    const decision = decideNextObjectiveItem({
      items,
      skill: 'LISTENING',
      attemptedCount: 1,
      lastDifficulty: 3,
      lastCorrect: false,
      seenItemIds: ['l3'],
    });
    expect(decision.targetDifficulty).toBe(2);
    expect(decision.itemId).toBe('l2');
  });

  it('达到每题上限后停止', () => {
    const decision = decideNextObjectiveItem({
      items,
      skill: 'LISTENING',
      attemptedCount: 2,
      lastDifficulty: 2,
      lastCorrect: true,
      seenItemIds: ['l2', 'l3'],
    });
    expect(decision.itemId).toBeNull();
    expect(decision.rationale).toContain('上限');
  });

  it('不选择 AI 练习题', () => {
    const onlyPractice = items.filter((item) => item.id === 'p1');
    const decision = decideNextObjectiveItem({
      items: onlyPractice,
      skill: 'LISTENING',
      attemptedCount: 1,
      lastDifficulty: 4,
      lastCorrect: true,
      seenItemIds: [],
    });
    expect(decision.itemId).toBeNull();
  });
});

describe('置信度与画像聚合', () => {
  const sample = (level: string, confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM'): SkillSample => ({
    skill: 'LISTENING',
    subskill: 'detail_understanding',
    level,
    confidence,
    sourceType: 'VERIFIED',
  });

  it('没有证据时暂不能判断', () => {
    const profile = estimateSkillProfile('LISTENING', [], ['a', 'b']);
    expect(profile.estimatedLevel).toBeNull();
    expect(profile.confidence).toBe('LOW');
    expect(profile.needsFollowUp).toBe(true);
  });

  it('单样本只给范围，不给单一等级', () => {
    const profile = estimateSkillProfile('LISTENING', [sample('A2')], ['a', 'b']);
    expect(profile.estimatedLevel).toBeNull();
    expect(profile.levelRange).toEqual(['A1', 'B1']);
    expect(profile.confidence).toBe('LOW');
  });

  it('两个一致样本为中置信度', () => {
    const profile = estimateSkillProfile('LISTENING', [sample('A2'), sample('A2')], ['a', 'b']);
    expect(profile.estimatedLevel).toBe('A2');
    expect(profile.confidence).toBe('MEDIUM');
  });

  it('三个一致样本为高置信度', () => {
    const profile = estimateSkillProfile('LISTENING', [sample('A2'), sample('A2'), sample('A2')], ['a', 'b']);
    expect(profile.confidence).toBe('HIGH');
    expect(profile.needsFollowUp).toBe(false);
  });

  it('结果冲突时降为低置信度', () => {
    const profile = estimateSkillProfile('LISTENING', [sample('A1'), sample('B2'), sample('A2')], ['a', 'b']);
    expect(profile.confidence).toBe('LOW');
    expect(profile.estimatedLevel).toBeNull();
    expect(profile.limitations.join('')).toContain('冲突');
  });

  it('开放任务样本少时强制低置信度', () => {
    const rubricSample: SkillSample = {
      skill: 'LISTENING',
      subskill: 'x',
      level: 'A2',
      confidence: 'HIGH',
      sourceType: 'RUBRIC',
    };
    const profile = estimateSkillProfile('LISTENING', [rubricSample], ['x']);
    expect(profile.confidence).toBe('LOW');
  });
});

describe('报告草稿', () => {
  const profile = (
    skill: SkillProfileDraft['skill'],
    level: string | null,
    confidence: SkillProfileDraft['confidence'],
    evidenceCount = 2,
  ): SkillProfileDraft => ({
    skill,
    estimatedLevel: level,
    levelRange: level ? [level, level] : ['Pre-A1', 'A1'],
    confidence,
    evidenceCount,
    coverageRatio: 0.5,
    subskills: ['x'],
    needsFollowUp: confidence !== 'HIGH',
    limitations: [],
  });

  it('四项技能分别呈现，不取平均', () => {
    const draft = buildReportDraft(
      [
        profile('LISTENING', 'A1', 'MEDIUM'),
        profile('READING', 'B1', 'MEDIUM'),
        profile('SPEAKING', null, 'LOW'),
        profile('WRITING', null, 'LOW'),
      ],
      (skill) => skill,
      2,
    );
    expect(draft.summary).toContain('不取平均');
    expect(draft.summary).not.toContain('总体等级');
    expect(draft.summary).toContain('SPEAKING：暂定 Pre-A1–A1');
    expect(draft.provisional).toBe(true);
    expect(draft.confidence).toBe('LOW');
  });

  it('低置信度技能进入补测建议', () => {
    const draft = buildReportDraft(
      [profile('LISTENING', null, 'LOW'), profile('READING', null, 'LOW')],
      (skill) => skill,
      0,
    );
    expect(draft.gaps.some((gap) => gap.includes('先补测'))).toBe(true);
    expect(draft.suggestions.join('')).toContain('待补测');
  });
});

describe('题库种子与计划预算', () => {
  it('题库自检通过', () => {
    expect(validateBankSeeds()).toEqual([]);
  });

  it('每个核心技能至少有一道基础题', () => {
    const codes = pickInitialItemCodes(true);
    const skills = new Set(
      DIAGNOSTIC_ITEM_SEEDS.filter((item) => codes.includes(item.itemCode)).map((item) => item.skill),
    );
    for (const skill of ['LISTENING', 'READING', 'SPEAKING', 'WRITING', 'GRAMMAR', 'VOCABULARY', 'SENTENCE_STRUCTURE', 'EMLR']) {
      expect(skills.has(skill as never)).toBe(true);
    }
  });

  it('计划使用每周预算而不是每天 240 分钟', () => {
    const plan = buildPlanDraft(
      [
        { skill: 'LISTENING', estimatedLevel: 'A2', levelRange: ['A1', 'A2'], confidence: 'MEDIUM', needsFollowUp: true, evidenceCount: 2 },
        { skill: 'READING', estimatedLevel: 'B1', levelRange: ['A2', 'B1'], confidence: 'MEDIUM', needsFollowUp: false, evidenceCount: 2 },
      ],
      { weeklyTargetMinutes: 300, weekdayProfiles: [60, 60, 60, 60, 60, 60, 0], defaultDailyMinutes: 60, isUserConfirmed: true },
    );
    expect(plan.budget.weeklyMinutes).toBe(300);
    expect(plan.budget.dailyAverage).toBe(43);
    const week7 = plan.phases.find((phase) => phase.window === '7D');
    const total = week7?.tasks.reduce((sum, task) => sum + task.minutes, 0) ?? 0;
    expect(total).toBeLessThanOrEqual(300);
    expect(plan.rationale.notes.join('')).toContain('每周预算 300 分钟');
  });

  it('低层级换算不会越界', () => {
    expect(levelBelow('Pre-A1')).toBe('Pre-A1');
    expect(levelBelow('A1')).toBe('Pre-A1');
  });
});