/**
 * 被测文件：src/lib/domain/tracks.ts
 * 规则来源：需求 §11.1（三轨道分别统计验收）/
 *           需求「CEFR、IELTS、媒介学习三者不可互相换算」/
 *           SOP v2 §3（媒介学习 A2–B1 试学、B1 后系统化）。
 *
 * P1 验收重点：
 *   ① 一条时长只计一次（轨道求和 === 总量，无重复）；
 *   ② 学习时长多但无评估证据 → 不判级；
 *   ③ IELTS 成绩与 CEFR 评估互不影响（成绩独立性）；
 *   ④ 媒介学习 gate 独立，且「有产出」才算有效记录。
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateGeneralEnglishGate,
  evaluateIeltsGate,
  evaluateMediatedGate,
  goalProgress,
  isMediatedEvidenceOutput,
  mediatedOutputCount,
  trackStats,
  type AssessmentEvidence,
  type IeltsEvidence,
  type MediatedEvidence,
} from '../tracks';
import {
  GE_GATE_MIN_ASSESSMENTS_PER_SKILL,
  IELTS_GATE_MAX_RECORDS,
  IELTS_GATE_MIN_RECORDS,
  MEDIATED_GATE_MIN_SESSIONS_SYSTEMATIC,
  MEDIATED_GATE_MIN_SESSIONS_TRIAL,
} from '../../constants';

describe('trackStats：一条时长只计一次', () => {
  it('按轨道分组求和，总量等于输入总和（不重复计时）', () => {
    const rows = [
      { track: 'GENERAL_ENGLISH', minutes: 60 },
      { track: 'IELTS_PREPARATION', minutes: 30 },
      { track: 'ENGLISH_MEDIATED_LEARNING', minutes: 45 },
    ];
    const { stats, totalMinutes } = trackStats(rows);

    expect(totalMinutes).toBe(135);
    // 关键断言：三条轨道之和 === 总量，说明没有双计
    const sumOfTracks = stats.reduce((sum, s) => sum + s.minutes, 0);
    expect(sumOfTracks).toBe(totalMinutes);
  });

  it('三条轨道按固定顺序返回（GENERAL → IELTS → MEDIATED）', () => {
    const { stats } = trackStats([]);
    expect(stats.map((s) => s.track)).toEqual([
      'GENERAL_ENGLISH',
      'IELTS_PREPARATION',
      'ENGLISH_MEDIATED_LEARNING',
    ]);
  });

  it('无数据时各轨道为 0、占比为 null', () => {
    const { stats, totalMinutes } = trackStats([]);
    expect(totalMinutes).toBe(0);
    for (const stat of stats) {
      expect(stat.minutes).toBe(0);
      expect(stat.sessionCount).toBe(0);
      expect(stat.shareOfTotal).toBeNull();
    }
  });

  it('未知轨道归入 GENERAL_ENGLISH 并单独计数', () => {
    const { stats, unknownTrackMinutes } = trackStats([
      { track: 'SOMETHING_ELSE', minutes: 20 },
      { track: 'GENERAL_ENGLISH', minutes: 10 },
    ]);
    const ge = stats.find((s) => s.track === 'GENERAL_ENGLISH');
    expect(ge?.minutes).toBe(30);
    expect(unknownTrackMinutes).toBe(20);
  });

  it('0 分钟与负数分钟被忽略，不增加 sessionCount', () => {
    const { stats, totalMinutes } = trackStats([
      { track: 'GENERAL_ENGLISH', minutes: 0 },
      { track: 'GENERAL_ENGLISH', minutes: -30 },
      { track: 'GENERAL_ENGLISH', minutes: 25 },
    ]);
    expect(totalMinutes).toBe(25);
    expect(stats.find((s) => s.track === 'GENERAL_ENGLISH')?.sessionCount).toBe(1);
  });

  it('占比之和为 1（有数据时）', () => {
    const { stats } = trackStats([
      { track: 'GENERAL_ENGLISH', minutes: 50 },
      { track: 'IELTS_PREPARATION', minutes: 30 },
      { track: 'ENGLISH_MEDIATED_LEARNING', minutes: 20 },
    ]);
    const sumShare = stats.reduce((sum, s) => sum + (s.shareOfTotal ?? 0), 0);
    expect(sumShare).toBeCloseTo(1, 10);
  });
});

// 四项技能全部达到某等级的评估证据快捷构造
function perfectAssessments(level: string, count = 1): AssessmentEvidence[] {
  const out: AssessmentEvidence[] = [];
  for (const skill of ['LISTENING', 'READING', 'SPEAKING', 'WRITING']) {
    for (let i = 0; i < count; i += 1) {
      out.push({ skill, cefrLevel: level, assessDate: `2026-11-0${i + 1}`, confidence: 0.8 });
    }
  }
  return out;
}

describe('evaluateGeneralEnglishGate：时长不构成升级依据', () => {
  it('学习时长极多但没有任何评估证据 → 不通过', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: [],
      targetLevel: 'B2',
      totalMinutes: 60000, // 1000 小时
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.length).toBe(4); // 四项各缺证据
    expect(result.basis).toContain('不构成升级依据');
  });

  it('只有部分技能有证据 → 不通过', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: [
        { skill: 'LISTENING', cefrLevel: 'B2', assessDate: '2026-11-01', confidence: 0.8 },
        { skill: 'READING', cefrLevel: 'B2', assessDate: '2026-11-01', confidence: 0.8 },
      ],
      targetLevel: 'B2',
      totalMinutes: 5000,
    });
    expect(result.suggested).toBe(false);
    const codes = result.gaps.map((g) => g.code);
    expect(codes).toContain('GE_EVIDENCE_SPEAKING');
    expect(codes).toContain('GE_EVIDENCE_WRITING');
  });

  it('四项均有证据但等级不足 → 不通过，且指出是哪项', () => {
    const assessments = perfectAssessments('B2');
    // 把写作降到 B1
    const idx = assessments.findIndex((a) => a.skill === 'WRITING');
    assessments[idx] = { ...assessments[idx], cefrLevel: 'B1' };

    const result = evaluateGeneralEnglishGate({
      assessments,
      targetLevel: 'B2',
      totalMinutes: 10000,
    });
    expect(result.suggested).toBe(false);
    const codes = result.gaps.map((g) => g.code);
    expect(codes).toContain('GE_LEVEL_WRITING');
    expect(codes).not.toContain('GE_LEVEL_LISTENING');
  });

  it('四项均有达标证据 → 通过', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: perfectAssessments('B2'),
      targetLevel: 'B2',
      totalMinutes: 3000,
    });
    expect(result.suggested).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('只看「最近一条」评估（历史达标、最新退步 → 不通过）', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: [
        { skill: 'LISTENING', cefrLevel: 'B2', assessDate: '2026-10-01', confidence: 0.8 },
        { skill: 'LISTENING', cefrLevel: 'B1', assessDate: '2026-11-01', confidence: 0.8 },
        { skill: 'READING', cefrLevel: 'B2', assessDate: '2026-11-01', confidence: 0.8 },
        { skill: 'SPEAKING', cefrLevel: 'B2', assessDate: '2026-11-01', confidence: 0.8 },
        { skill: 'WRITING', cefrLevel: 'B2', assessDate: '2026-11-01', confidence: 0.8 },
      ],
      targetLevel: 'B2',
      totalMinutes: 3000,
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('GE_LEVEL_LISTENING');
  });

  it('超出目标等级也算通过（C1 > B2）', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: perfectAssessments('C1'),
      targetLevel: 'B2',
      totalMinutes: 0,
    });
    expect(result.suggested).toBe(true);
  });

  it('总时长参数变化不影响判定结果（纯文案用途）', () => {
    const assessments = perfectAssessments('B2');
    const a = evaluateGeneralEnglishGate({ assessments, targetLevel: 'B2', totalMinutes: 0 });
    const b = evaluateGeneralEnglishGate({ assessments, targetLevel: 'B2', totalMinutes: 99999 });
    expect(a.suggested).toBe(b.suggested);
    expect(a.gaps.length).toBe(b.gaps.length);
  });

  it('每项技能的评估条数门槛来自常量', () => {
    const result = evaluateGeneralEnglishGate({
      assessments: perfectAssessments('B2', 1),
      targetLevel: 'B2',
      totalMinutes: 100,
    });
    // 门槛为 1 时通过；若常量改成 2，下面断言会失效并提示常量被改动
    expect(GE_GATE_MIN_ASSESSMENTS_PER_SKILL).toBe(1);
    expect(result.suggested).toBe(true);
  });
});

// 一条 IELTS 成绩的快捷构造
function ielts(
  testDate: string,
  overall: number,
  parts: Partial<Pick<IeltsEvidence, 'listeningBand' | 'readingBand' | 'writingBand' | 'speakingBand'>> = {},
  testType: IeltsEvidence['testType'] = 'MOCK',
): IeltsEvidence {
  return {
    testDate,
    testType,
    overallBand: overall,
    listeningBand: parts.listeningBand ?? overall,
    readingBand: parts.readingBand ?? overall,
    writingBand: parts.writingBand ?? overall,
    speakingBand: parts.speakingBand ?? overall,
  };
}

const TARGET_6_5 = {
  overall: 6.5,
  listening: 6.5,
  reading: 6.5,
  writing: 6.0,
  speaking: 6.0,
};

describe('evaluateIeltsGate：稳定达标 + 成绩独立', () => {
  it('成绩条数不足 → 不通过', () => {
    const result = evaluateIeltsGate({
      records: [ielts('2026-11-01', 6.5)],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps[0].code).toBe('IELTS_RECORDS');
    expect(IE_AT_LEAST_ONE()).toBe(true);
  });

  it('条数门槛来自常量（当前为 2）', () => {
    expect(IELTS_GATE_MIN_RECORDS).toBe(2);
    expect(IELTS_GATE_MAX_RECORDS).toBe(3);
  });

  it('两次均达标 → 通过', () => {
    const result = evaluateIeltsGate({
      records: [ielts('2026-10-01', 6.5), ielts('2026-11-01', 7.0)],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('只有一次达标、一次未达标 → 不通过（要求稳定，不是偶尔）', () => {
    const result = evaluateIeltsGate({
      records: [ielts('2026-10-01', 5.5), ielts('2026-11-01', 7.0)],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('IELTS_OVERALL');
  });

  it('PRACTICE 单项练习不计入 gate', () => {
    const result = evaluateIeltsGate({
      records: [
        ielts('2026-10-01', 7.0, {}, 'PRACTICE'),
        ielts('2026-11-01', 7.0, {}, 'PRACTICE'),
      ],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps[0].code).toBe('IELTS_RECORDS');
  });

  it('只取最近 3 条（更早的差成绩不再拖累）', () => {
    const result = evaluateIeltsGate({
      records: [
        ielts('2026-01-01', 4.0), // 很早的差成绩，应被排除
        ielts('2026-09-01', 6.5),
        ielts('2026-10-01', 6.5),
        ielts('2026-11-01', 6.5),
      ],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(true);
  });

  it('单项缺失算不通过（不能靠总分掩盖）', () => {
    const result = evaluateIeltsGate({
      records: [
        { ...ielts('2026-10-01', 7.0), writingBand: null },
        ielts('2026-11-01', 7.0),
      ],
      target: TARGET_6_5,
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('IELTS_MISSING_WRITING');
  });

  it('目标单项为 null 时不检查该项', () => {
    const result = evaluateIeltsGate({
      records: [
        { ...ielts('2026-10-01', 7.0), writingBand: 4.0 },
        { ...ielts('2026-11-01', 7.0), writingBand: 4.0 },
      ],
      target: { ...TARGET_6_5, writing: null },
    });
    expect(result.suggested).toBe(true);
  });

  it('判定文案明确写出「不影响 CEFR 估计」', () => {
    const result = evaluateIeltsGate({
      records: [ielts('2026-10-01', 7.0), ielts('2026-11-01', 7.0)],
      target: TARGET_6_5,
    });
    expect(result.basis).toContain('不影响 CEFR');
  });
});

// 小工具：让上面的「至少一条」断言可读
function IE_AT_LEAST_ONE(): boolean {
  return IELTS_GATE_MIN_RECORDS >= 1;
}

// 一条媒介学习记录的快捷构造
// 取值必须来自真实枚举：understanding ∈ FULL|PARTIAL|LOW；
// translationDependency ∈ NONE|SUBTITLE_EN|ZH_ASSIST|HEAVY_ZH。
// PARTIAL=0.6、SUBTITLE_EN=0.7 恰好达到 gate 门槛。
function mediated(over: Partial<MediatedEvidence> = {}): MediatedEvidence {
  return {
    sessionDate: '2026-11-01',
    primarySkill: 'READING',
    durationMinutes: 40,
    understanding: 'PARTIAL',
    translationDependency: 'SUBTITLE_EN',
    outputCount: 2,
    summaryChars: 200,
    ...over,
  };
}

describe('evaluateMediatedGate：独立验收 + 有产出才算有效', () => {
  it('试学门槛为 3 次（A2–B1）', () => {
    expect(MEDIATED_GATE_MIN_SESSIONS_TRIAL).toBe(3);
  });

  it('系统化门槛为 6 次（B1 之后）', () => {
    expect(MEDIATED_GATE_MIN_SESSIONS_SYSTEMATIC).toBe(6);
  });

  it('无记录 → 不通过', () => {
    const result = evaluateMediatedGate({ records: [], intensity: 'A2_B1' });
    expect(result.suggested).toBe(false);
  });

  it('三次记录但只覆盖一项技能 → 不通过（技能覆盖面）', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01' }),
        mediated({ sessionDate: '2026-11-02' }),
        mediated({ sessionDate: '2026-11-03' }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('MEDIATED_SKILLS');
  });

  it('三次记录覆盖四项技能且质量达标 → 通过', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01', primarySkill: 'READING' }),
        mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING' }),
        mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING' }),
        mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING' }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('没有英文产出（outputCount = 0）的记录不算有效', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', outputCount: 0 }),
        mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', outputCount: 0 }),
        mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', outputCount: 0 }),
        mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING', outputCount: 0 }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('MEDIATED_SESSIONS');
  });

  it('理解度 LOW 的记录不算有效', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', understanding: 'LOW' }),
        mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', understanding: 'LOW' }),
        mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', understanding: 'LOW' }),
        mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING', understanding: 'LOW' }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('MEDIATED_SESSIONS');
  });

  it('时长为 0 的记录不算有效（未真正学习）', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', durationMinutes: 0 }),
        mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', durationMinutes: 0 }),
        mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', durationMinutes: 0 }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(false);
  });

  it('中文翻译依赖过高 → 不通过', () => {
    const result = evaluateMediatedGate({
      records: [
        mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', translationDependency: 'HEAVY_ZH' }),
        mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', translationDependency: 'HEAVY_ZH' }),
        mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', translationDependency: 'HEAVY_ZH' }),
        mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING', translationDependency: 'HEAVY_ZH' }),
      ],
      intensity: 'A2_B1',
    });
    expect(result.suggested).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('MEDIATED_INDEPENDENCE');
  });

  it('系统化档位需要 6 次，3 次不足以通过', () => {
    const records = [
      mediated({ sessionDate: '2026-11-01', primarySkill: 'READING' }),
      mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING' }),
      mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING' }),
      mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING' }),
    ];
    const trial = evaluateMediatedGate({ records, intensity: 'A2_B1' });
    const systematic = evaluateMediatedGate({ records, intensity: 'B1_PLUS' });
    expect(trial.suggested).toBe(true);
    expect(systematic.suggested).toBe(false);
    expect(systematic.gaps.map((g) => g.code)).toContain('MEDIATED_SESSIONS');
  });

  it('恰好达到门槛阈值时判为通过（浮点边界回归，缺陷 D18）', () => {
    // 0.7 × 4 的平均值在 IEEE754 下是 0.6999999999999999，
    // 若不加容差，四条「恰好 = 0.7」的记录会被误判为不达标。
    const records = [
      mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', translationDependency: 'SUBTITLE_EN' }),
      mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', translationDependency: 'SUBTITLE_EN' }),
      mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', translationDependency: 'SUBTITLE_EN' }),
      mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING', translationDependency: 'SUBTITLE_EN' }),
    ];
    const result = evaluateMediatedGate({ records, intensity: 'A2_B1' });
    expect(result.gaps.map((g) => g.code)).not.toContain('MEDIATED_INDEPENDENCE');
    expect(result.suggested).toBe(true);
  });

  it('理解度恰好 = 0.6 时判为通过（浮点边界回归，缺陷 D18）', () => {
    // PARTIAL = 0.6，同样的浮点问题会让「正好及格」变成「不及格」
    const records = [
      mediated({ sessionDate: '2026-11-01', primarySkill: 'READING', understanding: 'PARTIAL' }),
      mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING', understanding: 'PARTIAL' }),
      mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING', understanding: 'PARTIAL' }),
      mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING', understanding: 'PARTIAL' }),
    ];
    const result = evaluateMediatedGate({ records, intensity: 'A2_B1' });
    expect(result.gaps.map((g) => g.code)).not.toContain('MEDIATED_UNDERSTANDING');
  });

  it('判定文案明确写出与 CEFR / IELTS 互不替代', () => {
    const result = evaluateMediatedGate({ records: [], intensity: 'A2_B1' });
    expect(result.basis).toContain('互不替代');
  });
});

describe('三 gate 互相独立（成绩独立性）', () => {
  it('IELTS 达标不影响 General English gate', () => {
    const ieltsOk = evaluateIeltsGate({
      records: [ielts('2026-10-01', 8.0), ielts('2026-11-01', 8.0)],
      target: TARGET_6_5,
    });
    const geNoEvidence = evaluateGeneralEnglishGate({
      assessments: [],
      targetLevel: 'B2',
      totalMinutes: 99999,
    });

    expect(ieltsOk.suggested).toBe(true);
    expect(geNoEvidence.suggested).toBe(false); // IELTS 8.0 也不能让 GE 通过
  });

  it('CEFR 达标不影响 IELTS gate', () => {
    const geOk = evaluateGeneralEnglishGate({
      assessments: perfectAssessments('C1'),
      targetLevel: 'B2',
      totalMinutes: 5000,
    });
    const ieltsNoRecords = evaluateIeltsGate({ records: [], target: TARGET_6_5 });

    expect(geOk.suggested).toBe(true);
    expect(ieltsNoRecords.suggested).toBe(false);
  });

  it('媒介学习达标不影响前两者', () => {
    const mediatedRecords = [
      mediated({ sessionDate: '2026-11-01', primarySkill: 'READING' }),
      mediated({ sessionDate: '2026-11-02', primarySkill: 'LISTENING' }),
      mediated({ sessionDate: '2026-11-03', primarySkill: 'SPEAKING' }),
      mediated({ sessionDate: '2026-11-04', primarySkill: 'WRITING' }),
    ];
    const mediatedOk = evaluateMediatedGate({ records: mediatedRecords, intensity: 'A2_B1' });
    const geNoEvidence = evaluateGeneralEnglishGate({
      assessments: [],
      targetLevel: 'B2',
      totalMinutes: 0,
    });
    const ieltsNoRecords = evaluateIeltsGate({ records: [], target: TARGET_6_5 });

    expect(mediatedOk.suggested).toBe(true);
    expect(geNoEvidence.suggested).toBe(false);
    expect(ieltsNoRecords.suggested).toBe(false);
  });
});

describe('goalProgress / isMediatedEvidenceOutput', () => {
  it('totalCount = 0 → null（不冒充 0%）', () => {
    expect(goalProgress({ achievedCount: 0, totalCount: 0 })).toBeNull();
  });

  it('正常比例', () => {
    expect(goalProgress({ achievedCount: 2, totalCount: 4 })).toBe(0.5);
  });

  it('结果被夹在 0..1', () => {
    expect(goalProgress({ achievedCount: 10, totalCount: 4 })).toBe(1);
    expect(goalProgress({ achievedCount: -5, totalCount: 4 })).toBe(0);
  });

  it('只有笔记/摘要/提问算有效产出', () => {
    expect(isMediatedEvidenceOutput('NOTE_EN')).toBe(true);
    expect(isMediatedEvidenceOutput('SUMMARY_EN')).toBe(true);
    expect(isMediatedEvidenceOutput('QUESTION_EN')).toBe(true);
    expect(isMediatedEvidenceOutput('UNKNOWN_TYPE')).toBe(false);
  });
});

describe('mediatedOutputCount：产出数口径唯一', () => {
  it('结构化 output + 三个内联文本任一非空各算 1', () => {
    expect(
      mediatedOutputCount({
        outputCount: 2,
        notesEn: 'some notes',
        summaryEn: null,
        questionsEn: '  ',
      }),
    ).toBe(3); // 2 条结构化 + 1 条笔记（空白问题不计）
  });

  it('空串与 null 不计', () => {
    expect(
      mediatedOutputCount({
        outputCount: 0,
        notesEn: null,
        summaryEn: '',
        questionsEn: '   ',
      }),
    ).toBe(0);
  });

  it('三个内联文本全部非空', () => {
    expect(
      mediatedOutputCount({
        outputCount: 0,
        notesEn: 'a',
        summaryEn: 'b',
        questionsEn: 'c',
      }),
    ).toBe(3);
  });
});
