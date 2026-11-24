/**
 * v2.1 golden：把 `generateAdaptivePlan` 的既有行为**逐字**钉住（`41 §3.3`）。
 *
 * 为什么必须先有这份文件再改代码：v2.7 要给 `AdaptivePlanInput` 追加四个可选字段，
 * 承诺"不传时与 v2.1 逐字相同"。若先改代码再生成基准，基准是**改完之后**跑出来的
 * —— 它当然一样，于是这句承诺从头到尾没有被验证过一次。
 *
 * 基准内容：`JSON.stringify(generateAdaptivePlan(input))`，**整对象**
 * （含 `items[].rationale` / `sortOrder` / `backlog` / `weeklyRotation` / `warnings`）。
 * 只比较"结构相等"是不够的 —— 文案与顺序变了对用户都是可见变更。
 *
 * 重新生成：`UPDATE_GOLDEN=1 npx vitest run src/lib/domain/__tests__/adaptivePlanGolden.test.ts`
 * **只允许在"确认这是有意的行为变更"时这么做**，并在 PR 里说明变了什么、为什么。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { generateAdaptivePlan } from '../adaptivePlan';
import { LEGACY_GOLDEN_CASES } from './fixtures/adaptivePlanLegacyInputs';

const goldenPath = new URL('./fixtures/adaptivePlan.v21.golden.json', import.meta.url);

/** 把一次调用序列化成基准串（`2` 空格缩进只为 diff 可读，比较用缩进后的同一份）。 */
function serialize(input: Parameters<typeof generateAdaptivePlan>[0]): string {
  const result = generateAdaptivePlan(input);
  return JSON.stringify(result, null, 2);
}

const current = LEGACY_GOLDEN_CASES.map((item) => ({ name: item.name, output: serialize(item.input) }));

const updateMode = process.env.UPDATE_GOLDEN === '1';
if (updateMode) {
  writeFileSync(goldenPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

const golden: { name: string; output: string }[] = JSON.parse(readFileSync(goldenPath, 'utf8'));

describe('v2.1 golden：18 组输入逐字不变', () => {
  it('基准文件覆盖全部 18 组（先证集合非空，防空集真空通过）', () => {
    expect(LEGACY_GOLDEN_CASES).toHaveLength(18);
    expect(golden).toHaveLength(18);
    expect(golden.map((row) => row.name)).toEqual(LEGACY_GOLDEN_CASES.map((row) => row.name));
  });

  it('断言 1：每组输出与基准**逐字**相同', () => {
    // 逐条比较而不是整体 `toEqual`：失败时能直接看出是**哪一组**、哪一处变了
    for (const [index, item] of LEGACY_GOLDEN_CASES.entries()) {
      const expected = golden[index];
      expect(expected, item.name).toBeTruthy();
      expect(serialize(item.input), item.name).toBe(expected!.output);
    }
  });

  it('断言 2：四个新字段全为 undefined 时逐字相同', () => {
    for (const [index, item] of LEGACY_GOLDEN_CASES.entries()) {
      const withUndefined = {
        ...item.input,
        bufferRatio: undefined,
        candidates: undefined,
        uncertainties: undefined,
        skillGaps: undefined,
      };
      expect(serialize(withUndefined), item.name).toBe(golden[index]!.output);
    }
  });

  it('断言 3：bufferRatio=0 时逐字相同（默认值不得改变 v2.1 行为）', () => {
    for (const [index, item] of LEGACY_GOLDEN_CASES.entries()) {
      expect(serialize({ ...item.input, bufferRatio: 0 }), item.name).toBe(golden[index]!.output);
    }
  });

  it('断言 4：三个空数组等价于未传（服务层默认会给 [] 而不是 undefined）', () => {
    for (const [index, item] of LEGACY_GOLDEN_CASES.entries()) {
      expect(
        serialize({ ...item.input, candidates: [], uncertainties: [], skillGaps: [] }),
        item.name,
      ).toBe(golden[index]!.output);
    }
  });
});
