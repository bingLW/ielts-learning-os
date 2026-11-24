/**
 * 计划输入快照的规范化与哈希（T02，H-1..H-5）+ 层级区间 `periodOf()`。
 *
 * 每条用例对应的都是一类**线上会安静发生**的事故：
 * - hash 把时间戳算进去 → 每次生成都新建快照，表按调用次数膨胀；
 * - 键序/数组序不稳定 → 同输入不同 hash，复用永不命中；
 * - 浮点没收敛 → `0.30000000000000004` 让两个等价输入算出两个 hash；
 * - `[]` 与 `null` 混为一谈 → 「源挂了」和「源是空的」在快照里无法区分；
 * - 规则/权重没进 hash → 改了权重却复用旧快照，解释与结论对不上。
 */

import { describe, expect, it } from 'vitest';
import {
  LAYER_SPAN_DAYS,
  type HashablePlanningInput,
  PLANNING_HASH_LENGTH,
  RULE_VERSION,
  canonicalizePlanningValue,
  hashPlanningInput,
  parseSkillTargets,
  periodOf,
} from '../planningSnapshot';
import { addDays } from '../../date';

/** 一份最小的可哈希输入（已含 H-5 要求的两项）。 */
function baseInput(over: Partial<HashablePlanningInput> = {}): HashablePlanningInput {
  return {
    weightsVersion: 'v1',
    config: { minTaskMinutes: 5, bufferRatio: 0.1 },
    purpose: 'GENERATE',
    asOfDate: '2025-10-20',
    horizonDays: 7,
    stage: { code: 'S3_B1_IELTS', profileCode: 'B1_B2' },
    budget: { minutes: 60, tierCode: 'STANDARD', isRestDay: false, isInitialSuggestion: false },
    dueReviews: [],
    gaps: [],
    candidates: [],
    ...over,
  };
}

describe('H-1：键序与数组序不稳定不影响 hash', () => {
  it('同输入两次 → 同 hash', () => {
    expect(hashPlanningInput(baseInput())).toBe(hashPlanningInput(baseInput()));
  });

  it('键的顺序打乱 → 同 hash', () => {
    const shuffled = {
      candidates: [],
      gaps: [],
      dueReviews: [],
      budget: { minutes: 60, tierCode: 'STANDARD', isRestDay: false, isInitialSuggestion: false },
      stage: { code: 'S3_B1_IELTS', profileCode: 'B1_B2' },
      horizonDays: 7,
      asOfDate: '2025-10-20',
      purpose: 'GENERATE',
      config: { bufferRatio: 0.1, minTaskMinutes: 5 },
      weightsVersion: 'v1',
    };
    expect(hashPlanningInput(shuffled)).toBe(hashPlanningInput(baseInput()));
  });

  it('数组顺序打乱（元素有稳定主键）→ 同 hash', () => {
    const a = baseInput({
      candidates: [
        { candidateKey: 'REVIEW:r1:READING', module: 'READING' },
        { candidateKey: 'PROBE:g1:READING', module: 'READING' },
      ],
    });
    const b = baseInput({
      candidates: [
        { candidateKey: 'PROBE:g1:READING', module: 'READING' },
        { candidateKey: 'REVIEW:r1:READING', module: 'READING' },
      ],
    });
    expect(hashPlanningInput(a)).toBe(hashPlanningInput(b));
  });

  it('缺口按 dimensionKind|skill|subskill 排序，顺序不影响 hash', () => {
    const one = { dimensionKind: 'OFFICIAL', skill: 'READING', subskill: 'gist', severity: 0.4 };
    const two = { dimensionKind: 'AUXILIARY', skill: 'GRAMMAR', subskill: 'articles', severity: 0.2 };
    expect(hashPlanningInput(baseInput({ gaps: [one, two] }))).toBe(
      hashPlanningInput(baseInput({ gaps: [two, one] })),
    );
  });
});

describe('H-2：原始时间戳绝不进 hash', () => {
  it('createdAt 不同但其余相同 → 同 hash（否则快照永不复用）', () => {
    const a = baseInput({ createdAt: '2025-10-20T01:00:00.000Z', updatedAt: '2025-10-20T01:00:00.000Z' });
    const b = baseInput({ createdAt: '2025-10-21T09:30:00.000Z', updatedAt: '2025-10-21T09:30:00.000Z' });
    expect(hashPlanningInput(a)).toBe(hashPlanningInput(b));
  });

  it('派生整数（freshnessDays / overdueDays）必须进 hash —— 它们变了结论就变了', () => {
    const a = baseInput({ gaps: [{ skill: 'READING', subskill: '', freshnessDays: 5 }] });
    const b = baseInput({ gaps: [{ skill: 'READING', subskill: '', freshnessDays: 6 }] });
    expect(hashPlanningInput(a)).not.toBe(hashPlanningInput(b));
  });

  it('嵌套对象里的时间戳同样被剔除', () => {
    const a = baseInput({ stage: { code: 'S3_B1_IELTS', profileCode: 'B1_B2', startedAt: '2025-01-01T00:00:00Z' } });
    const b = baseInput({ stage: { code: 'S3_B1_IELTS', profileCode: 'B1_B2', startedAt: '2025-06-01T00:00:00Z' } });
    expect(hashPlanningInput(a)).toBe(hashPlanningInput(b));
  });
});

describe('H-3：浮点统一 round(3)', () => {
  it('0.30000000000000004 与 0.3 → 同 hash', () => {
    const a = baseInput({ gaps: [{ skill: 'READING', subskill: '', severity: 0.3 }] });
    const b = baseInput({ gaps: [{ skill: 'READING', subskill: '', severity: 0.1 + 0.2 }] });
    expect(hashPlanningInput(a)).toBe(hashPlanningInput(b));
  });

  it('0.3001 与 0.3002 在 3 位精度下同 hash（差异小于收敛精度）', () => {
    const a = baseInput({ gaps: [{ skill: 'READING', subskill: '', severity: 0.3001 }] });
    const b = baseInput({ gaps: [{ skill: 'READING', subskill: '', severity: 0.3002 }] });
    expect(hashPlanningInput(a)).toBe(hashPlanningInput(b));
  });
});

describe('H-4：null / undefined 归一，但 [] ≠ null', () => {
  it('undefined 与 null 等同', () => {
    expect(canonicalizePlanningValue({ a: undefined, b: null })).toEqual({ a: null, b: null });
  });

  it('空数组与 null 是**不同**的 hash（源为空 vs 源不可用）', () => {
    expect(hashPlanningInput(baseInput({ dueReviews: [] }))).not.toBe(
      hashPlanningInput(baseInput({ dueReviews: null })),
    );
  });
});

describe('H-5：规则/权重/配置必须进 hash', () => {
  it('只改 weightsVersion → hash 变', () => {
    expect(hashPlanningInput(baseInput({ weightsVersion: 'v2' }))).not.toBe(
      hashPlanningInput(baseInput()),
    );
  });

  it('只改 config 里的一个阈值 → hash 变', () => {
    expect(
      hashPlanningInput(baseInput({ config: { minTaskMinutes: 10, bufferRatio: 0.1 } })),
    ).not.toBe(hashPlanningInput(baseInput()));
  });

  it('RULE_VERSION 进 hash（结构上写死，无法漏传）', () => {
    expect(RULE_VERSION).toBe('v2.7.0');
    const canonical = canonicalizePlanningValue({ v: RULE_VERSION, a: 1 });
    expect(canonical).toEqual({ a: 1, v: RULE_VERSION });
  });

  it('缺 weightsVersion / config 直接抛错，而不是算出一个会误复用旧快照的 hash', () => {
    const noWeights = baseInput();
    delete (noWeights as Record<string, unknown>).weightsVersion;
    expect(() => hashPlanningInput(noWeights as never)).toThrow(/weightsVersion/);

    const noConfig = baseInput();
    delete (noConfig as Record<string, unknown>).config;
    expect(() => hashPlanningInput(noConfig as never)).toThrow(/config/);
  });
});

describe('hash 形态', () => {
  it('固定 32 位十六进制', () => {
    const hash = hashPlanningInput(baseInput());
    expect(hash).toHaveLength(PLANNING_HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('periodOf：层级区间由纯函数派生（区间不落列）', () => {
  it('null / DAY → 当天', () => {
    expect(periodOf({ layer: null, planDate: '2025-10-20' })).toEqual({
      layer: 'DAY',
      start: '2025-10-20',
      end: '2025-10-20',
    });
    expect(periodOf({ planDate: '2025-10-20' })).toEqual({
      layer: 'DAY',
      start: '2025-10-20',
      end: '2025-10-20',
    });
  });

  it('WEEK → +6 / MONTH → +29 / CYCLE → +89', () => {
    expect(periodOf({ layer: 'WEEK', planDate: '2025-10-20' }).end).toBe(
      addDays('2025-10-20', 6),
    );
    expect(periodOf({ layer: 'MONTH', planDate: '2025-10-20' }).end).toBe(
      addDays('2025-10-20', 29),
    );
    expect(periodOf({ layer: 'CYCLE', planDate: '2025-10-20' }).end).toBe(
      addDays('2025-10-20', 89),
    );
    expect(LAYER_SPAN_DAYS).toEqual({ DAY: 0, WEEK: 6, MONTH: 29, CYCLE: 89 });
  });

  it('跨月跨年也算得对（纯字符串日期运算，不碰时区）', () => {
    expect(periodOf({ layer: 'WEEK', planDate: '2025-12-29' }).end).toBe('2026-01-04');
    expect(periodOf({ layer: 'MONTH', planDate: '2026-02-01' }).end).toBe('2026-03-02');
  });

  it('未知层级直接抛错（静默当 DAY 会让 30 天版本缩成 1 天）', () => {
    expect(() => periodOf({ layer: 'QUARTER', planDate: '2025-10-20' })).toThrow(/未知的计划层级/);
  });
});

describe('parseSkillTargets：把宽类型收紧成 Partial（NaN 的第一道闸）', () => {
  it('丢掉非 SkillId 的键（脏配置不该变成"某个技能有目标"）', () => {
    const targets = parseSkillTargets({ READING: 7, NOT_A_SKILL: 9, VOCAB: 6 });
    expect(targets).toEqual({ READING: 7, VOCAB: 6 });
    expect('NOT_A_SKILL' in targets).toBe(false);
  });

  it('未列出的技能读出来是 undefined（调用方必须 ?? 回落，不许当 0）', () => {
    const targets = parseSkillTargets({ READING: 7 });
    expect(targets.SPEAKING).toBeUndefined();
    // 这条是"类型收紧"的意义所在：`Record<string, number>` 会让 TS 声称这里是 number
    expect(typeof targets.SPEAKING).toBe('undefined');
  });

  it('非有限数 / 负数 / 非对象输入被丢弃，不产生 NaN', () => {
    expect(parseSkillTargets({ READING: Number.NaN, VOCAB: -1, GRAMMAR: 6 })).toEqual({
      GRAMMAR: 6,
    });
    for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
      expect(parseSkillTargets(bad)).toEqual({});
    }
  });

  it('null / 空串 / 空数组 / false **丢键**，不许变成「目标 0 分」', () => {
    // `LearningGoal.min*` 是 `Float?`，用户建档时往往只填关心的两三项。
    // 用 `Number(value)` 收窄会得到 `0` —— 于是「没设目标」被读成「目标 0 分」，
    // 读侧算出"已完全达标"。这两件事在数值上都正常，事后无法归因。
    expect(parseSkillTargets({ READING: null })).toEqual({});
    expect('READING' in parseSkillTargets({ READING: null })).toBe(false);
    for (const bad of ['', [], false, '20', {}, Number.POSITIVE_INFINITY]) {
      const parsed = parseSkillTargets({ READING: bad });
      expect(parsed, JSON.stringify(bad)).toEqual({});
      expect('READING' in parsed, JSON.stringify(bad)).toBe(false);
    }
  });

  it('真实形状：只填了两项、其余为 null → 只有两个键', () => {
    const targets = parseSkillTargets({
      LISTENING: 7,
      READING: null,
      WRITING: 6.5,
      SPEAKING: null,
    });
    expect(Object.keys(targets).sort()).toEqual(['LISTENING', 'WRITING']);
    expect(targets.READING).toBeUndefined();
  });

  it('一条真值 + 一条 null → 只留真值（不因 null 拖累整批）', () => {
    expect(parseSkillTargets({ READING: null, VOCAB: 6 })).toEqual({ VOCAB: 6 });
  });

  it('**显式 0 必须保留** —— 对照用例，防「修 bug 时顺手把 0 也丢了」', () => {
    // `{READING: 0}` 与「没有 READING 这个键」是两件事：
    // 前者读侧算出"已完全达标"，后者走"该技能与目标无直接关系"的中性分。
    // 判据必须是**键是否存在**，不是值真假 —— 所以实现里不许出现 `if (!value) continue`。
    // 这条在修 `Number()` 之前就是绿的，它守的不是那个 bug，而是修复过程本身。
    const targets = parseSkillTargets({ READING: 0 });
    expect(targets).toEqual({ READING: 0 });
    expect('READING' in targets).toBe(true);
    expect(targets.READING).toBe(0);
  });
});
