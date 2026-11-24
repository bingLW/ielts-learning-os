/**
 * v2.7 T06a：来源标签表的编译期封闭 + 运行时兜底（G-13 ⑧⑨）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  TASK_SOURCE_KINDS,
  TASK_SOURCE_LABEL_ZH,
  taskSourceLabel,
} from '../../constants';
import type { TaskSourceKind } from '../../types';

describe('taskSourceLabel', () => {
  it('七个合法值逐个非空，且与原表逐字一致', () => {
    expect(TASK_SOURCE_KINDS).toHaveLength(7);
    for (const kind of TASK_SOURCE_KINDS) {
      expect(taskSourceLabel(kind).length).toBeGreaterThan(0);
      expect(taskSourceLabel(kind)).toBe(TASK_SOURCE_LABEL_ZH[kind]);
    }
  });

  it('未知键返回原值，不渲染空白', () => {
    expect(taskSourceLabel('WHATEVER')).toBe('WHATEVER');
    expect(taskSourceLabel('')).toBe('');
  });

  it('标签表在编译期封闭：缺一个键必须编译失败', () => {
    // @ts-expect-error 缺 RETEST —— 若表被放宽成 Record<string,string>，此指令变成 unused，typecheck:test 会红
    const incomplete: Record<(typeof TASK_SOURCE_KINDS)[number], string> = {
      REVIEW: '复习',
      CORE: '阶段核心',
      WEAKNESS: '弱项',
      EXTENDED: '拓展',
      MANUAL: '手工',
      LEGACY: 'v2.0 历史',
    };
    expect(incomplete).toBeTruthy();

    // 数量守门：防止有人把上面那条编译期指令整行删掉（G-13 ⑧ + §1.9 A-3）。
    // 行首锚定，避免把正文里提到这个词的那句注释算进去。
    const src = readFileSync(new URL('./taskSourceLabel.test.ts', import.meta.url), 'utf8');
    expect(src.match(/^[ \t]*\/\/[ \t]*@ts-expect-error/gm) ?? []).toHaveLength(1);
  });

  it('类型层面允许直接拿 TASK_SOURCE_KINDS 的元素查表', () => {
    const kind: TaskSourceKind = 'RETEST';
    expect(TASK_SOURCE_LABEL_ZH[kind]).toBe('证据复测');
  });
});
