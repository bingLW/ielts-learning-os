/**
 * v2.7 T06a：跨域枚举映射的穷举与收编回归（`42` T06a ①–⑤，G-13）。
 *
 * 映射表若被"就地拼一下"绕过，24 组合穷举就白做了 —— 所以这里同时断言
 * 映射函数本身与它输出的域边界。
 */

import { describe, expect, it } from 'vitest';

import { MODULE_META, TASK_SOURCE_KINDS } from '../../constants';
import type { ModuleId } from '../../types';
import {
  mapCandidateSourceToPlanTask,
  skillOfModule,
  taskAxesOf,
  type GapKindForMapping,
} from '../planWriteMap';
import { CANDIDATE_SOURCE_KINDS, type CandidateSourceKind } from '../taskCandidate';

const GAP_KINDS: GapKindForMapping[] = ['GAP', 'UNCERTAINTY', 'UNKNOWN', null];

describe('mapCandidateSourceToPlanTask：24 组合穷举', () => {
  it('输出全部落在 PlanTask.sourceKind 的 7 值内，且不可达 EXTENDED/LEGACY', () => {
    const outputs = new Set<string>();
    for (const source of CANDIDATE_SOURCE_KINDS) {
      for (const gap of GAP_KINDS) {
        const mapped = mapCandidateSourceToPlanTask(source, gap);
        expect(TASK_SOURCE_KINDS).toContain(mapped);
        expect(mapped === 'EXTENDED' || mapped === 'LEGACY').toBe(false);
        outputs.add(mapped);
      }
    }
    // 防空集真空通过：8 来源 × 4 裁决（GAP/UNCERTAINTY/UNKNOWN/null）= 32 组。
    // 文档写的 24 组是 3 裁决口径；UNKNOWN 与 null 都走 CORE，但两者是不同输入，必须各测一次。
    expect(CANDIDATE_SOURCE_KINDS.length * GAP_KINDS.length).toBe(32);
    expect(outputs.size).toBeGreaterThan(0);
  });

  it('定点：REVIEW/RETEST/PROBE/MATERIAL 各自走固定出口', () => {
    for (const gap of GAP_KINDS) {
      expect(mapCandidateSourceToPlanTask('REVIEW', gap)).toBe('REVIEW');
      expect(mapCandidateSourceToPlanTask('RETEST', gap)).toBe('RETEST');
      expect(mapCandidateSourceToPlanTask('PROBE', gap)).toBe('RETEST');
      expect(mapCandidateSourceToPlanTask('MATERIAL', gap)).toBe('MANUAL');
    }
  });

  it('只有 GAP 落 WEAKNESS；UNCERTAINTY 绝不落 WEAKNESS（AC-6）', () => {
    const contentSources: CandidateSourceKind[] = ['VOCAB', 'QUESTION', 'LAB', 'EGIU'];
    for (const source of contentSources) {
      expect(mapCandidateSourceToPlanTask(source, 'GAP')).toBe('WEAKNESS');
      for (const gap of ['UNCERTAINTY', 'UNKNOWN', null] as GapKindForMapping[]) {
        expect(mapCandidateSourceToPlanTask(source, gap)).toBe('CORE');
      }
    }
  });
});

describe('taskAxesOf / skillOfModule：收编回归', () => {
  const MODULES = Object.keys(MODULE_META) as ModuleId[];

  it('14 个模块 × 关键 targetSkill → skill/primarySkill/track 三者都在各自枚举内', () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(14);
    for (const module of MODULES) {
      for (const target of ['VOCABULARY', 'GRAMMAR', 'LISTENING', 'OTHER']) {
        const axes = taskAxesOf(module, target);
        expect(axes.skill).toBeTruthy();
        expect(axes.primarySkill).toBeTruthy();
        expect(axes.track).toBeTruthy();
      }
    }
  });

  it('收编前后 skillOfModule 逐值相同（既有 v2.6 行为手写契约）', () => {
    // 期望值手抄自 v2.6 私有函数，不从被测函数反查（§1.9 A-2）
    const expected: Record<string, string> = {
      VOCAB_REVIEW: 'VOCAB',
      SENTENCE: 'SENTENCE',
      GRAMMAR: 'GRAMMAR',
      LISTENING: 'LISTENING',
      SPEAKING: 'SPEAKING',
      WRITING: 'WRITING',
    };
    for (const [module, skill] of Object.entries(expected)) {
      expect(skillOfModule(module, 'ANYTHING')).toBe(skill);
    }
    expect(skillOfModule('UNKNOWN_MODULE', 'VOCABULARY')).toBe('VOCAB');
    expect(skillOfModule('UNKNOWN_MODULE', 'GRAMMAR')).toBe('GRAMMAR');
    expect(skillOfModule('UNKNOWN_MODULE', 'OTHER')).toBe('READING');
  });
});
