/**
 * G-14：映射表的键集合必须由枚举闭合（`41 §1.8`）。
 *
 * 这一层要挡的不是"表写错了"，而是**类型被悄悄放宽回去**。
 *
 * `as const { … }` 版与 `Record<枚举联合, V>` 版在类型层面**无法区分**：
 * 两者都能过 `Object.keys()` 断言，编译也都通过。所以如果有人把
 * `Record<DiagTaskType | MaterialExerciseType, number>` 改回 `as const { … }`，
 * 编译绿、运行期断言绿，规则就丢了 —— 直到某天加了一个新枚举值。
 *
 * 唯一能挡住这件事的是**读源码文本**：声明处必须出现 `Record<`。
 * 它是本文件里最"不像测试"的一条，但也是唯一有效的一条。
 *
 * 三道（`41 §8`）：
 * 1. 声明处含 `Record<`；
 * 2. `Object.keys(table).sort()` 与枚举数组**集合相等**（不是 `arrayContaining`）；
 * 3. 逐键 `Number.isFinite(v) && v > 0` —— 漏键在算术里是 `NaN`、在渲染里是空白，都不报错。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_DEFAULT_MINUTES,
  CANDIDATE_FALLBACK_MINUTES,
  LISTENING_MODES,
  MATERIAL_EXERCISE_TYPES,
  SPEAKING_TASK_TYPES,
  TASK_SOURCE_KINDS,
  TASK_SOURCE_LABEL_ZH,
} from '@/lib/constants';
import { DIAG_TASK_TYPES } from '@/lib/diagnostic/constants';
import {
  CANDIDATE_SOURCE_KINDS,
  CANDIDATE_SOURCE_PRIORITY,
} from '@/lib/domain/taskCandidate';

const constantsSource = readFileSync(
  join(process.cwd(), 'src', 'lib', 'constants.ts'),
  'utf8',
);
const taskCandidateSource = readFileSync(
  join(process.cwd(), 'src', 'lib', 'domain', 'taskCandidate.ts'),
  'utf8',
);

/** 取某个 `export const NAME` 声明处到下一个空行为止的源码片段。 */
function declarationOf(source: string, name: string): string {
  const index = source.indexOf(`export const ${name}`);
  if (index < 0) throw new Error(`找不到声明：${name}`);
  return source.slice(index, index + 600);
}

describe('第一道：声明处必须用 Record<…> 定型（不是 as const）', () => {
  it('CANDIDATE_DEFAULT_MINUTES 的两张子表绑定到**具体联合**（不是 Record<string>）', () => {
    const decl = declarationOf(constantsSource, 'CANDIDATE_DEFAULT_MINUTES');
    // 只断言 `Record<` 太弱：`Record<string, string>` 也能过。
    // 必须钉到具体联合，否则"放宽回宽泛类型"这个改动会从这条断言下面溜过去。
    expect(decl).toMatch(/QUESTION:\s*Record<DiagTaskType \| MaterialExerciseType,/);
    expect(decl).toMatch(/LAB:\s*Record<ListeningMode \| SpeakingTaskType,/);
    expect(decl).not.toMatch(/Record<string/);
  });

  it('CANDIDATE_FALLBACK_MINUTES / TASK_SOURCE_LABEL_ZH / CANDIDATE_SOURCE_PRIORITY 都是 Record<', () => {
    expect(declarationOf(constantsSource, 'CANDIDATE_FALLBACK_MINUTES')).toMatch(
      /Record<MinuteBearingSourceKind,/,
    );
    expect(declarationOf(constantsSource, 'TASK_SOURCE_LABEL_ZH')).toMatch(
      /Record<\(typeof TASK_SOURCE_KINDS\)\[number\],/,
    );
    expect(declarationOf(taskCandidateSource, 'CANDIDATE_SOURCE_PRIORITY')).toMatch(
      /Record<CandidateSourceKind,/,
    );
    // 任何一张表放宽成 Record<string, …> 都视为规则丢失
    for (const name of ['CANDIDATE_FALLBACK_MINUTES', 'TASK_SOURCE_LABEL_ZH']) {
      expect(declarationOf(constantsSource, name)).not.toMatch(/Record<string/);
    }
  });
});

describe('第二道：键集合与枚举集合相等（不是包含）', () => {
  it('QUESTION 的键 = 诊断域 ∪ 材料域（8 个）', () => {
    const expected = [...new Set<string>([...DIAG_TASK_TYPES, ...MATERIAL_EXERCISE_TYPES])];
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.QUESTION).sort()).toEqual(expected.sort());
    expect(expected).toHaveLength(8);
  });

  it('LAB 的键 = 听力 ∪ 口语（并集去重后 17 个，不去重会 18 个假红）', () => {
    // RETELLING 同时属于听力与口语：**必须去重**，否则 9 + 9 = 18 ≠ 17，
    // 测试假红之后大概率有人去表里补一个不存在的键来"修好"它
    const union = new Set<string>([...LISTENING_MODES, ...SPEAKING_TASK_TYPES]);
    expect(union.size, 'RETELLING 共用一项，并集应为 17').toBe(17);
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB).sort()).toEqual([...union].sort());
  });

  it('两张分钟表的键互补，并集 = 8 个候选来源', () => {
    const derived = Object.keys(CANDIDATE_DEFAULT_MINUTES);
    const fallback = Object.keys(CANDIDATE_FALLBACK_MINUTES);
    expect([...derived, ...fallback].sort()).toEqual([...CANDIDATE_SOURCE_KINDS].sort());
    expect(derived.filter((key) => fallback.includes(key))).toEqual([]);
  });

  it('TASK_SOURCE_LABEL_ZH 的键 = TASK_SOURCE_KINDS（漏一个就是空白标签）', () => {
    expect(Object.keys(TASK_SOURCE_LABEL_ZH).sort()).toEqual([...TASK_SOURCE_KINDS].sort());
  });

  it('CANDIDATE_SOURCE_PRIORITY 的键 = CANDIDATE_SOURCE_KINDS', () => {
    expect(Object.keys(CANDIDATE_SOURCE_PRIORITY).sort()).toEqual(
      [...CANDIDATE_SOURCE_KINDS].sort(),
    );
  });
});

describe('第三道：逐键必须是正的有限数（漏键 = NaN，不报错）', () => {
  it('DEFAULT 表所有值都 > 0', () => {
    expect(Number.isFinite(CANDIDATE_DEFAULT_MINUTES.PROBE)).toBe(true);
    expect(CANDIDATE_DEFAULT_MINUTES.PROBE).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(CANDIDATE_DEFAULT_MINUTES.QUESTION)) {
      expect(Number.isFinite(value), `QUESTION.${key}`).toBe(true);
      expect(value, `QUESTION.${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(CANDIDATE_DEFAULT_MINUTES.LAB)) {
      expect(Number.isFinite(value), `LAB.${key}`).toBe(true);
      expect(value, `LAB.${key}`).toBeGreaterThan(0);
    }
  });

  it('FALLBACK 表所有值都 > 0', () => {
    for (const [key, value] of Object.entries(CANDIDATE_FALLBACK_MINUTES)) {
      expect(Number.isFinite(value), `FALLBACK.${key}`).toBe(true);
      expect(value, `FALLBACK.${key}`).toBeGreaterThan(0);
    }
  });
});
