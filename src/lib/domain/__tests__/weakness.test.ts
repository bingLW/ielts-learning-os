/**
 * 被测文件：src/lib/domain/weakness.ts（rankWeaknesses）
 * 规则来源：PRD §6.5（五因子加权 0.35/0.25/0.15/0.15/0.10；同 key 去重取各分项 max；
 *           样本 <10 题不参与排序、单列「数据不足」；Top3 必带依据；投入缺口权重最低）
 *           + PRD §8「薄弱点排序必须可单测」。
 */

import { describe, expect, it } from 'vitest';
import { rankWeaknesses } from '../weakness';
import type { WeaknessCandidate } from '../weakness';
import { WEAKNESS_MIN_QUESTIONS, WEAKNESS_TOP_N, WEAKNESS_WEIGHTS } from '../../constants';

/** 构造候选维度；默认「无投入差异、无复习债、无红灯」，避免默认值伪造薄弱。 */
function candidate(over: Partial<WeaknessCandidate> & { key: string; name: string }): WeaknessCandidate {
  return {
    scope: 'SKILL',
    totalQuestions: 20,
    wrongQuestions: 8,
    subjectAcc: null,
    dimAcc: null,
    plannedMinutes: 0,
    actualMinutes: 0,
    reviewTotal: 0,
    reviewOverdue: 0,
    unitTotal: 0,
    unitRed: 0,
    ...over,
  };
}

describe('权重常量（PRD §6.5）', () => {
  it('五因子权重与样本阈值', () => {
    expect(WEAKNESS_WEIGHTS.ERR, '错题率权重 0.35').toBe(0.35);
    expect(WEAKNESS_WEIGHTS.ACC_GAP, '正确率缺口 0.25').toBe(0.25);
    expect(WEAKNESS_WEIGHTS.INVEST_GAP, '投入缺口 0.15（刻意最低）').toBe(0.15);
    expect(WEAKNESS_WEIGHTS.REVIEW_DEBT, '复习债 0.15').toBe(0.15);
    expect(WEAKNESS_WEIGHTS.RED_DENSITY, '红灯密度 0.10').toBe(0.1);
    expect(WEAKNESS_MIN_QUESTIONS, '样本阈值 10 题').toBe(10);
    expect(WEAKNESS_TOP_N, 'Top3').toBe(3);
  });
});

describe('rankWeaknesses —— 投入缺口不得主导排序', () => {
  it('「练得多但正确率低」必须排在「练得少但正确率高」之前', () => {
    const { ranked } = rankWeaknesses([
      // 练得少（40/400）但正确率高（错 2/20）
      candidate({
        key: 'LISTENING',
        name: '听力',
        plannedMinutes: 400,
        actualMinutes: 40,
        totalQuestions: 20,
        wrongQuestions: 2,
        subjectAcc: 0.9,
        dimAcc: 0.9,
      }),
      // 练得足（400/400）但错 8/20，且低于科目均分
      candidate({
        key: 'READING',
        name: '阅读',
        plannedMinutes: 400,
        actualMinutes: 400,
        totalQuestions: 20,
        wrongQuestions: 8,
        subjectAcc: 0.9,
        dimAcc: 0.5,
      }),
    ]);

    expect(ranked[0].name, '能力缺口必须先于投入缺口：阅读应排第一').toBe('阅读');
    expect(ranked[0].score, '阅读 = 0.35×0.4 + 0.25×0.4 = 0.24').toBeCloseTo(0.24, 3);
    expect(ranked[1].score, '听力 = 0.35×0.1 + 0.15×0.9 = 0.17').toBeCloseTo(0.17, 3);
  });

  it('即使把投入缺口拉满（0.15），也压不过「错一半」的 0.175', () => {
    const { ranked } = rankWeaknesses([
      // 完全没练：investGap = 1 → 0.15，但没错题
      candidate({
        key: 'SPEAKING',
        name: '口语',
        plannedMinutes: 400,
        actualMinutes: 0,
        totalQuestions: 20,
        wrongQuestions: 0,
      }),
      // 练满了但错一半：errRate 0.5 → 0.175
      candidate({
        key: 'WRITING',
        name: '写作',
        plannedMinutes: 400,
        actualMinutes: 400,
        totalQuestions: 20,
        wrongQuestions: 10,
      }),
    ]);

    expect(ranked[0].name, '权重设计意图：花时间少 ≠ 能力弱，错一半更该补').toBe('写作');
    expect(ranked[0].score, '0.35 × 0.5 = 0.175').toBeCloseTo(0.175, 3);
    expect(ranked[1].score, '投入缺口拉满也只有 0.15').toBeCloseTo(0.15, 3);
  });

  it('没有计划分钟时不制造投入缺口（planned=0 → 0，而不是 1）', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'VOCAB', name: '词汇', plannedMinutes: 0, actualMinutes: 0, wrongQuestions: 0 }),
    ]);
    expect(ranked[0].score, '无计划 → investGap 0，分数为 0').toBe(0);
  });
});

describe('rankWeaknesses —— 分数公式逐项核对', () => {
  it('单一信号：错 4/10 → 0.35 × 0.4 = 0.14', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'A', name: '语法', totalQuestions: 10, wrongQuestions: 4 }),
    ]);
    expect(ranked[0].score, '只有 wrongQuestions 时分数 = 0.35 × 0.4').toBe(0.14);
  });

  it('正确率缺口参与：科目 90% / 维度 50% → 0.25 × 0.4 = 0.1', () => {
    const { ranked } = rankWeaknesses([
      candidate({
        key: 'B',
        name: '阅读',
        totalQuestions: 20,
        wrongQuestions: 10,
        subjectAcc: 0.9,
        dimAcc: 0.5,
      }),
    ]);
    expect(ranked[0].score, '0.35×0.5 + 0.25×0.4 = 0.275').toBeCloseTo(0.275, 3);
  });

  it('复习债与红灯密度参与：3/10 逾期 + 2/4 红灯', () => {
    const { ranked } = rankWeaknesses([
      candidate({
        key: 'C',
        name: '错题复习',
        totalQuestions: 20,
        wrongQuestions: 0,
        reviewTotal: 10,
        reviewOverdue: 3,
        unitTotal: 4,
        unitRed: 2,
      }),
    ]);
    expect(ranked[0].score, '0.15×0.3 + 0.10×0.5 = 0.095').toBeCloseTo(0.095, 3);
  });

  it('分数保留 3 位小数', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'D', name: '听力', totalQuestions: 10, wrongQuestions: 1 }),
    ]);
    expect(ranked[0].score, '0.35×0.1 = 0.035').toBe(0.035);
  });
});

describe('rankWeaknesses —— 依据与行动建议', () => {
  it('依据文案按「错 X/Y 题 · 主要类别 · 逾期 · 红灯 · 趋势」拼装', () => {
    const { ranked } = rankWeaknesses([
      candidate({
        key: 'E',
        name: '语法：三单',
        scope: 'KNOWLEDGE',
        totalQuestions: 12,
        wrongQuestions: 7,
        mainErrorCategory: 'MEMORY_CONFUSION',
        reviewOverdue: 3,
        reviewTotal: 5,
        unitRed: 2,
        unitTotal: 3,
        trendDelta: 3,
      }),
    ]);
    expect(ranked[0].evidence, '依据必须可解释到原始计数').toBe(
      '错 7/12 题 · 主要类别=记忆混淆 · 逾期复习 3 条 · 红灯单元 2 个 · 较上周↑3',
    );
  });

  it('趋势为负时显示↓', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'F', name: '写作', trendDelta: -2 }),
    ]);
    expect(ranked[0].evidence.includes('较上周↓2'), '负趋势用↓').toBe(true);
  });

  it('行动建议优先级：先清逾期 → 再重学红灯 → 否则追加专项练习', () => {
    const withOverdue = rankWeaknesses([
      candidate({ key: 'G', name: '听力', reviewOverdue: 2, unitRed: 1 }),
    ]);
    expect(withOverdue.ranked[0].actionHint, '有逾期时先清债').toBe(
      '先清 2 条逾期复习，再追加 15 分钟专项练习',
    );

    const withRed = rankWeaknesses([candidate({ key: 'H', name: '阅读', unitRed: 3 })]);
    expect(withRed.ranked[0].actionHint, '无逾期但有红灯时先重学').toBe(
      '重学 3 个红灯单元并当日复测至黄灯以上',
    );

    const plain = rankWeaknesses([candidate({ key: 'I', name: '口语' })]);
    expect(plain.ranked[0].actionHint, '都没有时给通用建议').toBe('本周计划中追加 15 分钟专项练习');
  });

  it('无任何信号时依据文案为「证据不足」', () => {
    const { insufficient } = rankWeaknesses([
      candidate({ key: 'J', name: '词汇', totalQuestions: 0, wrongQuestions: 0 }),
    ]);
    expect(insufficient[0].evidence, '没有证据时必须说清楚，而不是空串').toBe('证据不足');
  });
});

describe('rankWeaknesses —— 样本阈值与数量约束', () => {
  it('样本 <10 题进「数据不足」，不进 Top3', () => {
    const { ranked, insufficient } = rankWeaknesses([
      candidate({ key: 'K', name: '语法', totalQuestions: 5, wrongQuestions: 4 }),
    ]);
    expect(ranked, '样本不足不参与排序').toEqual([]);
    expect(insufficient.length, '但要单列出来让用户知道存在这块数据').toBe(1);
  });

  it('阈值按多来源证据量累加判定，不因单来源样本小被埋（裁决 B）', () => {
    const { ranked, insufficient } = rankWeaknesses([
      candidate({ key: 'THIN', name: '语法', totalQuestions: 6, wrongQuestions: 3 }),
      candidate({ key: 'THIN', name: '语法', totalQuestions: 6, wrongQuestions: 3 }),
    ]);
    expect(
      ranked.length,
      'PRD §6.5 的阈值口径是「该维度总题数 < 10」——维度级而非来源级：' +
        '6 + 6 = 12 道题的证据 ≥ 10，必须进 Top3。按单来源 6 题判「数据不足」会系统性埋掉' +
        '「同一知识点分散在多来源」的维度，而那正是最该被看见的薄弱点',
    ).toBe(1);
    expect(insufficient, '过了阈值就不能同时出现在「数据不足」里，两个列表互斥').toEqual([]);
    // 但展示仍取最差来源的原始 6 题：阈值累加 ≠ 展示累加
    expect(
      ranked[0].evidence,
      '阈值可累加、展示不可累加：卡片依据必须是最差来源的原始分子分母',
    ).toMatch(/^错 3\/6 题/);
    expect(
      ranked[0].evidence,
      '「3/12」= 把 evidenceQuestions 当成展示分母，正是 D15 的退化形态，两个字段各司其职',
    ).not.toContain('3/12');

    // 对照组：累加后仍不足阈值时照样拦下——证明这不是「多来源一律放行」
    const belowThreshold = rankWeaknesses([
      candidate({ key: 'THIN2', name: '语法', totalQuestions: 4, wrongQuestions: 2 }),
      candidate({ key: 'THIN2', name: '语法', totalQuestions: 4, wrongQuestions: 2 }),
    ]);
    expect(
      belowThreshold.insufficient.length,
      '4 + 4 = 8 < 10：累加是为了让分散证据被看见，不是为了降低门槛',
    ).toBe(1);
    expect(belowThreshold.ranked, '不足阈值的维度不得进 Top3').toEqual([]);
  });

  it('合格项不足 3 项时原样返回，不补空位', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'L', name: '听力', wrongQuestions: 8 }),
      candidate({ key: 'M', name: '阅读', wrongQuestions: 2 }),
    ]);
    expect(ranked.length, '只有 2 项合格就返回 2 项，不抛错也不补空').toBe(2);
  });

  it('合格项多于 3 项时恰好返回 3 项，且按分数降序', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'N1', name: 'A科', wrongQuestions: 9 }),
      candidate({ key: 'N2', name: 'B科', wrongQuestions: 7 }),
      candidate({ key: 'N3', name: 'C科', wrongQuestions: 5 }),
      candidate({ key: 'N4', name: 'D科', wrongQuestions: 3 }),
      candidate({ key: 'N5', name: 'E科', wrongQuestions: 1 }),
    ]);
    expect(ranked.length, '必须恰好 3 项').toBe(3);
    expect(ranked.map((item) => item.name), '分数降序取前三').toEqual(['A科', 'B科', 'C科']);
  });

  it('全部无数据时返回空数组而不是抛错', () => {
    const result = rankWeaknesses([
      candidate({ key: 'O1', name: 'A科', totalQuestions: 0, wrongQuestions: 0 }),
      candidate({ key: 'O2', name: 'B科', totalQuestions: 0, wrongQuestions: 0 }),
    ]);
    expect(result.ranked, '没有任何合格样本时 Top3 为空').toEqual([]);
    expect(result.insufficient.length, '两个都进数据不足').toBe(2);
  });

  it('空候选列表 → 两个数组都是空', () => {
    expect(rankWeaknesses([]), '空输入不能抛错').toEqual({ ranked: [], insufficient: [] });
  });

  it('opts 可覆盖样本阈值与 TopN', () => {
    const result = rankWeaknesses(
      [
        candidate({ key: 'P1', name: 'A科', totalQuestions: 20, wrongQuestions: 9 }),
        candidate({ key: 'P2', name: 'B科', totalQuestions: 5, wrongQuestions: 3 }),
      ],
      { minQuestions: 20, limit: 1 },
    );
    expect(result.ranked.length, 'limit=1').toBe(1);
    expect(result.insufficient.length, 'minQuestions=20 时 B 科不达标').toBe(1);
  });
});

describe('rankWeaknesses —— 并列稳定与幂等', () => {
  it('同分时按名称升序，且两次调用结果完全一致（幂等）', () => {
    const input = [
      candidate({ key: 'Q1', name: 'ZZZ 科目', wrongQuestions: 4 }),
      candidate({ key: 'Q2', name: 'AAA 科目', wrongQuestions: 4 }),
    ];
    const first = rankWeaknesses(input);
    const second = rankWeaknesses(input);

    expect(first.ranked.map((item) => item.name), '同分按名称升序，保证界面不抖动').toEqual([
      'AAA 科目',
      'ZZZ 科目',
    ]);
    expect(second, '同一输入两次调用必须完全相同').toEqual(first);
  });

  it('同 key 多来源只出现一次', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'SAME', name: '听力', totalQuestions: 10, wrongQuestions: 5 }),
      candidate({ key: 'SAME', name: '听力', totalQuestions: 10, wrongQuestions: 5 }),
    ]);
    expect(ranked.length, 'PRD §6.5：同一 key 在多来源出现只计 1 次').toBe(1);
  });

  it('同 key 多来源合并后不得稀释错题率（PRD：各分项取 max）', () => {
    const { ranked } = rankWeaknesses([
      candidate({ key: 'SAME2', name: '听力', totalQuestions: 10, wrongQuestions: 5 }),
      candidate({ key: 'SAME2', name: '听力', totalQuestions: 10, wrongQuestions: 5 }),
    ]);
    expect(
      ranked[0].score,
      'D14（已修复，仅打分侧）：两个来源都是「错 5/10」，按 PRD §6.5「各分项取 max」→ errRate 0.5 → 0.35×0.5 = 0.175；' +
        '修复前的实现把分母累加、分子取 max，错题率被稀释成 0.25 → 0.0875（历史算式，勿回退）。' +
        '注意这不是一次闭环：展示侧是另一个缺陷 D15（见下一条），两条缺一不可',
    ).toBeCloseTo(0.175, 3);
  });

  it('D15：合并展示必须取最差来源的原始分子分母，不得跨来源拼装', () => {
    const { ranked } = rankWeaknesses([
      // 同一 key 的两个来源：一条错 9/10，一条全对 0/10
      candidate({ key: 'WORST', name: '听力', totalQuestions: 10, wrongQuestions: 9 }),
      candidate({ key: 'WORST', name: '听力', totalQuestions: 10, wrongQuestions: 0 }),
      // 对照组：错 8/10 → 0.35×0.8 = 0.28，必须排在合并项（0.315）之后
      candidate({ key: 'RUNNER', name: '阅读', totalQuestions: 10, wrongQuestions: 8 }),
    ]);

    const top = ranked[0];
    expect(top.name, 'D15：合并项错 90%，必须排第一（0.315 > 0.28）').toBe('听力');
    expect(top.score, 'D15：打分用 errRate = 0.9 → 0.35×0.9 = 0.315').toBeCloseTo(0.315, 3);
    expect(
      top.evidence,
      'D15：依据必须与排序同一口径——取最差来源的原始 9/10',
    ).toMatch(/^错 9\/10 题/);
    expect(
      top.evidence,
      'D15：不得出现「分子取 max + 分母累加」的 9/20（读作 45%，与排名依据的 90% 自相矛盾）',
    ).not.toContain('9/20');
    expect(
      top.evidence,
      'D15：不得取错来源拼成 0/10（那是另一条来源的分子分母，不是最差来源）',
    ).not.toContain('0/10');
    expect(
      top.evidence,
      'D15：多来源合并（sourceCount=2）必须加「（最差来源）」限定，避免被读成该维度全量统计',
    ).toContain('（最差来源）');
  });

  it('D15 平局规则：errRate 相同取样本量更大的来源，且与来源顺序无关', () => {
    const thin = () => candidate({ key: 'TIE', name: '听力', totalQuestions: 2, wrongQuestions: 1 });
    const fat = () => candidate({ key: 'TIE', name: '听力', totalQuestions: 10, wrongQuestions: 5 });

    const forward = rankWeaknesses([thin(), fat()]);
    const backward = rankWeaknesses([fat(), thin()]);

    expect(forward.ranked[0].score, '1/2 与 5/10 都是 50% → 0.35×0.5 = 0.175').toBeCloseTo(0.175, 3);
    expect(
      forward.ranked[0].evidence,
      'D15：平局取样本量更大的来源——「错 1/2」这种极薄样本不能当 Top3 卡片的依据',
    ).toMatch(/^错 5\/10 题/);
    expect(forward.ranked[0].evidence, 'D15：不得把 2 题样本摆上卡片').not.toContain('1/2');
    expect(
      backward,
      'D15：来源顺序颠倒后结果必须完全相同（否则查询层加个 ORDER BY 就会让文案漂移）',
    ).toEqual(forward);
  });
});

describe('rankWeaknesses —— 待办量按分子挑来源（口径 C）', () => {
  /**
   * 逾期条数与红灯单元数是**待办量**，不是比率：用户读到「逾期 5 条」的意思是
   * 「我今天要清 5 条」。所以挑来源必须按**分子**，不能按 rate。
   *
   * 本用例是 `shouldReplaceCount` 的唯一防线 —— 三条 D15 用例都只覆盖错题率（rate 口径），
   * 把这里改成 `shouldReplaceSample` 会让它们全绿，而界面上的待办数悄悄少报。
   */
  it('逾期按分子挑：3/4 的 0.75 不得盖掉 5/10 的 5 条', () => {
    const make = (overdue: number, total: number) =>
      candidate({
        key: 'DEBT',
        name: '错题复习',
        wrongQuestions: 4,
        reviewOverdue: overdue,
        reviewTotal: total,
      });

    const forward = rankWeaknesses([make(3, 4), make(5, 10)]);
    const backward = rankWeaknesses([make(5, 10), make(3, 4)]);

    expect(
      forward.ranked[0].evidence,
      '待办量取分子更大者：卡片必须说「逾期 5 条」，因为确实有 5 条没清',
    ).toContain('逾期复习 5 条');
    expect(
      forward.ranked[0].evidence,
      '按 rate 挑的退化形态：3/4 的 0.75 赢过 5/10 的 0.50，会少报 2 条待办',
    ).not.toContain('逾期复习 3 条');
    expect(
      forward.ranked[0].actionHint,
      '行动建议与依据必须来自同一条来源：先说清 5 条，不能说 3 条',
    ).toBe('先清 5 条逾期复习，再追加 15 分钟专项练习');
    expect(
      backward,
      '两种顺序结果必须完全相同，否则查询层加个 ORDER BY 就能让待办数漂移',
    ).toEqual(forward);
  });
});
