/**
 * 被测文件：src/lib/domain/color.ts（judgeEgiuColor / needsLowVolumeRetest）
 * 规则来源：PRD §6.1（分支顺序：输入校验 → total=0 PENDING → 硬否决 → 题量充足档 → 降权档）
 *           + SOP §5 三色表 + PRD Q2（题量不足追加 +2 天补测）。
 *
 * 说明：本文件只补 color.test.ts 未覆盖的边界，不重复既有 9 组官方案例。
 */

import { describe, expect, it } from 'vitest';
import { judgeEgiuColor, needsLowVolumeRetest } from '../color';
import type { EgiuJudgeResult } from '../color';
import { generateReviewPoints } from '../review';
import {
  FULL_VOLUME_MIN_QUESTIONS,
  GREEN_ACC,
  LOW_VOLUME_MIN_SENTENCES,
  LOW_VOLUME_PASS,
  LOW_VOLUME_SENTENCE_HALF,
  LOW_VOLUME_W,
  YELLOW_ACC,
} from '../../constants';
import type { EgiuJudgeInput, EgiuJudgment } from '../../types';

/** 满分基线：10/9 + 解释 + 造句 2 → GREEN。 */
const BASE: EgiuJudgeInput = {
  total: 10,
  correct: 9,
  explainOK: true,
  sentences: 2,
  coreRuleOK: true,
};

function judge(over: Partial<EgiuJudgeInput> = {}): EgiuJudgeResult {
  return judgeEgiuColor({ ...BASE, ...over });
}

/** 断言成功并取出 judgment；失败时错误信息直接带出真实失败码。 */
function judgmentOf(result: EgiuJudgeResult, hint: string): EgiuJudgment {
  expect(result.ok, hint).toBe(true);
  if (!result.ok) throw new Error(`${hint}（实际返回失败码 ${result.code}）`);
  return result.judgment;
}

describe('阈值常量（断言变更时能立刻定位到是常量漂移而不是代码写错）', () => {
  it('三色档位阈值与降权权重符合 PRD §6.1', () => {
    expect(GREEN_ACC, '绿灯正确率门槛应为 90%').toBe(0.9);
    expect(YELLOW_ACC, '黄灯正确率门槛应为 70%').toBe(0.7);
    expect(FULL_VOLUME_MIN_QUESTIONS, '题量充足门槛应为 5 题').toBe(5);
    expect(LOW_VOLUME_PASS, '降权档绿灯综合分门槛应为 0.85').toBe(0.85);
    expect(LOW_VOLUME_MIN_SENTENCES, '造句达标句数应为 2').toBe(2);
    expect(LOW_VOLUME_W.ACC, '正确率权重 30%').toBe(0.3);
    expect(LOW_VOLUME_W.EXPLAIN, '解释权重 40%').toBe(0.4);
    expect(LOW_VOLUME_W.SENTENCE, '造句权重 30%').toBe(0.3);
  });
});

describe('judgeEgiuColor —— 0 题与非法输入', () => {
  it('total=0 → PENDING（ZERO 分支），且绝不生成复习点', () => {
    const result = judge({ total: 0, correct: 0, explainOK: false, sentences: 0, coreRuleOK: false });
    const judgment = judgmentOf(result, 'total=0 必须正常返回判定，不是错误码');
    expect(judgment.color, '0 题不判定，必须是 PENDING').toBe('PENDING');
    expect(judgment.branch, '0 题必须走 ZERO 分支').toBe('ZERO');

    const points = generateReviewPoints({
      d0: '2025-05-01',
      today: '2025-05-01',
      color: judgment.color,
      totalQuestions: 0,
      existing: [],
    });
    expect(points, 'PENDING 不得排程任何复习点').toEqual([]);
  });

  it('total=0 且 coreRuleOK=false → 仍是 PENDING，硬否决不能作用于「无数据」', () => {
    const judgment = judgmentOf(
      judge({ total: 0, correct: 0, coreRuleOK: false, explainOK: false, sentences: 0 }),
      'total=0 + 未理解规则：应先命中 ZERO 分支',
    );
    expect(judgment.color, '无数据优先于硬否决：必须 PENDING').toBe('PENDING');
    expect(judgment.branch, '分支顺序：ZERO 在 OVERRIDE 之前').toBe('ZERO');
  });

  it('total=0 且 correct>0 —— 非法数据必须被拒绝（PRD §6.1 输入校验）', () => {
    const result = judge({ total: 0, correct: 3, explainOK: false, sentences: 0, coreRuleOK: true });
    expect(
      result.ok,
      'D1（已修复）：correct>total 的校验必须前置，0 题 3 对这类脏数据不得被静默判 PENDING',
    ).toBe(false);
    if (!result.ok) expect(result.code, '非法数据应返回 CORRECT_GT_TOTAL').toBe('CORRECT_GT_TOTAL');
  });

  it('correct > total → CORRECT_GT_TOTAL，不抛异常', () => {
    const result = judge({ total: 5, correct: 6 });
    expect(result.ok, 'correct>total 必须返回失败码而不是抛异常').toBe(false);
    if (!result.ok) expect(result.code).toBe('CORRECT_GT_TOTAL');
  });

  it('correct<0 / total<0 → NEGATIVE_INPUT', () => {
    const negativeCorrect = judge({ total: 5, correct: -1 });
    expect(negativeCorrect.ok, 'correct 为负数必须判非法').toBe(false);
    if (!negativeCorrect.ok) expect(negativeCorrect.code).toBe('NEGATIVE_INPUT');

    const negativeTotal = judge({ total: -5, correct: 0 });
    expect(negativeTotal.ok, 'total 为负数必须判非法').toBe(false);
    if (!negativeTotal.ok) expect(negativeTotal.code).toBe('NEGATIVE_INPUT');
  });
});

describe('judgeEgiuColor —— 硬否决优先于档位', () => {
  it('coreRuleOK=false 且正确率 100% → 必须 RED（OVERRIDE 分支）', () => {
    const judgment = judgmentOf(
      judge({ total: 10, correct: 10, sentences: 5, coreRuleOK: false }),
      '不理解核心规则时，任何正确率都必须走判定而不是报错',
    );
    expect(judgment.color, '红灯：coreRuleOK=false 必须硬否决，不能被 100% 正确率救回').toBe('RED');
    expect(judgment.branch, '硬否决必须标记 OVERRIDE 分支').toBe('OVERRIDE');
  });

  it('coreRuleOK=false 且题量很少（2/2）→ 仍 RED（OVERRIDE 优先于降权档）', () => {
    const judgment = judgmentOf(
      judge({ total: 2, correct: 2, sentences: 3, coreRuleOK: false }),
      '降权档也必须先看硬否决',
    );
    expect(judgment.color, '硬否决优先于「题量少降权」档位').toBe('RED');
    expect(judgment.branch, '必须是 OVERRIDE，不是 LOW_VOLUME').toBe('OVERRIDE');
  });
});

describe('judgeEgiuColor —— 题量充足档（total ≥ 5）', () => {
  it('90% 整 → GREEN（含边界，10 题对 9 题）', () => {
    const judgment = judgmentOf(judge({ total: 10, correct: 9 }), '90% 应满足 GREEN_ACC');
    expect(judgment.color, '90% 整属绿灯边界，必须 GREEN').toBe('GREEN');
    expect(judgment.branch).toBe('FULL');
  });

  it('89.9% → YELLOW（不能四舍五入成绿灯）', () => {
    const judgment = judgmentOf(judge({ total: 1000, correct: 899 }), '89.9% 应落在黄灯档');
    expect(judgment.color, '89.9% 不足 90%，必须 YELLOW').toBe('YELLOW');
  });

  it('70% 整 → YELLOW（含边界）', () => {
    const judgment = judgmentOf(judge({ total: 10, correct: 7 }), '70% 整属黄灯下边界');
    expect(judgment.color, '70% 整必须 YELLOW（≥YELLOW_ACC 含等号）').toBe('YELLOW');
  });

  it('69.9% → RED', () => {
    const judgment = judgmentOf(judge({ total: 1000, correct: 699 }), '69.9% 应落红灯档');
    expect(judgment.color, '69.9% 低于 70%，必须 RED').toBe('RED');
  });

  it('total=5 时 90% 不可达（4/5=80% → YELLOW）：记录边界事实', () => {
    const judgment = judgmentOf(judge({ total: 5, correct: 4 }), '5 题对 4 题 = 80%');
    expect(judgment.color, '5 题无法整除到 90%，4/5 只能是 YELLOW').toBe('YELLOW');
  });

  it('FULL 分支不返回 score 字段（score 只属于降权档）', () => {
    const judgment = judgmentOf(judge({ total: 10, correct: 9 }), 'FULL 分支判定');
    expect(judgment.score, 'FULL 分支不应带 score，避免 UI 误展示降权综合分').toBeUndefined();
  });

  it('题量充足但只造 1 句 → YELLOW（造句不足 2 句不能给绿灯）', () => {
    const judgment = judgmentOf(judge({ total: 10, correct: 10, sentences: 1 }), '造句 1 句');
    expect(judgment.color, '造句只有 1 句时即使全对也只能 YELLOW').toBe('YELLOW');
  });
});

describe('judgeEgiuColor —— 降权档（1 ≤ total ≤ 4）', () => {
  it('total=4 且解释+造句双达标 → 允许 GREEN（满分边界）', () => {
    const judgment = judgmentOf(judge({ total: 4, correct: 4, sentences: 2 }), '4/4 + 双达标');
    expect(judgment.color, '题量少但证据齐全且综合分 1.00，必须允许 GREEN').toBe('GREEN');
    expect(judgment.branch, '降权档必须标记 LOW_VOLUME').toBe('LOW_VOLUME');
    expect(judgment.score, '满分降权综合分应为 1.00').toBeCloseTo(1, 5);
  });

  it('total=4 双达标但综合分 < 0.85 → 必须封顶 YELLOW（1/4 对）', () => {
    const judgment = judgmentOf(judge({ total: 4, correct: 1, sentences: 2 }), '1/4 + 双达标');
    expect(
      judgment.color,
      '降权综合分 = 0.3×0.25 + 0.4 + 0.3 = 0.775 < 0.85，证据齐全也只能 YELLOW',
    ).toBe('YELLOW');
    expect(judgment.score, '综合分应为 0.775').toBeCloseTo(0.775, 5);
    expect(judgment.branch).toBe('LOW_VOLUME');
  });

  it('total=4、1/4 对且双达标 → 自动追加 +2 天补测点（PRD Q2）', () => {
    expect(needsLowVolumeRetest('YELLOW', 4), '题量<5 的黄灯必须追加补测').toBe(true);

    const points = generateReviewPoints({
      d0: '2025-05-01',
      today: '2025-05-01',
      color: 'YELLOW',
      totalQuestions: 4,
      existing: [],
    });
    const manual = points.find((point) => point.intervalCode === 'MANUAL');
    expect(manual, '题量不足的黄灯必须生成 MANUAL 补测点').toBeDefined();
    expect(manual?.dueDate, 'MANUAL 补测点距今 +2 天').toBe('2025-05-03');
  });

  it('题量充足（total=5）的黄灯不追加补测点', () => {
    expect(needsLowVolumeRetest('YELLOW', 5), 'total≥5 不属于题量不足').toBe(false);
  });

  it('非 YELLOW 一律不追加补测点', () => {
    expect(needsLowVolumeRetest('GREEN', 3)).toBe(false);
    expect(needsLowVolumeRetest('RED', 3)).toBe(false);
    expect(needsLowVolumeRetest('PENDING', 0)).toBe(false);
  });

  it('total=4 全对但只造 1 句 → 综合分恰好 0.85 也必须 YELLOW（证据不足不换分数）', () => {
    const judgment = judgmentOf(judge({ total: 4, correct: 4, sentences: 1 }), '4/4 但造句 1 句');
    expect(
      judgment.color,
      '综合分 0.3+0.4+0.15=0.85 达标，但「双达标」前置条件不满足 → 必须 YELLOW',
    ).toBe('YELLOW');
    expect(judgment.score, '造句折半分 0.15').toBeCloseTo(
      LOW_VOLUME_W.ACC + LOW_VOLUME_W.EXPLAIN + LOW_VOLUME_SENTENCE_HALF,
      5,
    );
  });

  it('total=1、全对但无解释无造句 → RED（降权档证据全无）', () => {
    const judgment = judgmentOf(
      judge({ total: 1, correct: 1, explainOK: false, sentences: 0 }),
      '1/1 但无解释无造句',
    );
    expect(judgment.color, '降权档证据全无时，即使正确率 100% 也判 RED').toBe('RED');
    expect(judgment.score, '综合分只有正确率部分 0.3').toBeCloseTo(0.3, 5);
  });

  it('只有解释或只有造句 → YELLOW（证据不全但不至于红灯）', () => {
    const onlyExplain = judgmentOf(
      judge({ total: 4, correct: 2, sentences: 0, explainOK: true }),
      '只有解释',
    );
    expect(onlyExplain.color, '只有解释：证据不全 → YELLOW').toBe('YELLOW');

    const onlySentence = judgmentOf(
      judge({ total: 4, correct: 2, sentences: 2, explainOK: false }),
      '只有造句',
    );
    expect(onlySentence.color, '只有造句：证据不全 → YELLOW').toBe('YELLOW');
  });
});
