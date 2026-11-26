/**
 * G-1 净学习分钟唯一口径的结构守门（T10）。
 *
 * 断言三件事，全部读 Prisma 的 DMMF（不是 schema 文本正则 —— 注释、`///` 文档
 * 都会让文本扫描误报）：
 *
 * 1. v2.7 五张新表**不得**出现任何分钟列（`TaskCandidate` 的三张候选分钟除外，
 *    它们是「预计/最小/上限」，且被 G-2 禁止进入统计）；
 * 2. `SkillGap` 不得有 `stale` / `staleFlag` 列 —— 「是否失效」是派生结论，
 *    落库就会与上游版本不同步（C-D 裁决）；
 * 3. 全库匹配 `/^(actual|net|duration).*Minutes$/i` 的字段只能来自历史快照白名单；
 *    新增一个就是新增第二套「实际分钟」口径（I-1 被破坏）。
 *
 * 白名单不是豁免区：每条都写清「它为什么可以存在」，且测试断言白名单**无僵尸**
 * （列被删掉后必须同时删条目，否则名单只增不减）。
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const MODELS = Prisma.dmmf.datamodel.models;

function fieldsOf(model: string): string[] {
  const found = MODELS.find((row) => row.name === model);
  if (!found) throw new Error(`Prisma DMMF 里找不到 model ${model}`);
  return found.fields.map((field) => field.name);
}

/** 全库「实际/净/时长」分钟列白名单：每条都必须解释为什么不是第二套口径。 */
const MINUTES_FIELD_ALLOWLIST: { field: string; reason: string }[] = [
  { field: 'PlanTask.actualMinutes', reason: '任务实际分钟快照；真值仍以 ΣStudySessionDaySplit.minutes 为准' },
  { field: 'StudyRecord.actualMinutes', reason: 'v2.0 学习记录快照，只做表内自洽，不参与任何汇总' },
  { field: 'DailySummary.netMinutes', reason: 'v2.0 日总结快照（仅展示），不作净时长来源' },
  {
    field: 'EnglishMediatedSession.durationMinutes',
    reason: 'v2.0 媒介学习记录本表自洽字段；总净时长仍只从 DaySplit 求和',
  },
];

describe('G-1 v2.7 新表不携带「实际/净分钟」列', () => {
  it('SkillGap / PlanningSnapshot / TaskPriorityDecision / StageReadinessReview 没有任何分钟列', () => {
    for (const model of ['SkillGap', 'PlanningSnapshot', 'TaskPriorityDecision', 'StageReadinessReview']) {
      const minutes = fieldsOf(model).filter((name) => /minute|second/i.test(name));
      expect(minutes, `${model} 不允许出现时长列`).toEqual([]);
    }
  });

  it('TaskCandidate 只有三张候选分钟（预计/最小/上限），没有「实际」', () => {
    const minutes = fieldsOf('TaskCandidate')
      .filter((name) => /minute|second/i.test(name))
      .sort();
    expect(minutes).toEqual(['estMinutes', 'maxBlockMinutes', 'minMinutes']);
  });

  it('SkillGap 不含 stale / staleFlag（派生字段不落库）', () => {
    const fields = fieldsOf('SkillGap').map((name) => name.toLowerCase());
    expect(fields).not.toContain('stale');
    expect(fields).not.toContain('staleflag');
  });
});

describe('G-1 全库时长类列白名单', () => {
  it('匹配实际/净/时长的分钟列只有历史快照白名单，且白名单无僵尸', () => {
    const hits = new Set<string>();
    for (const model of MODELS) {
      for (const field of model.fields) {
        if (/^(actual|net|duration).*Minutes$/i.test(field.name)) {
          hits.add(`${model.name}.${field.name}`);
        }
      }
    }

    const allowed = new Set(MINUTES_FIELD_ALLOWLIST.map((entry) => entry.field));
    const unexpected = [...hits].filter((field) => !allowed.has(field));
    expect(unexpected, '出现白名单外的「实际/净」分钟列：这就是第二套口径').toEqual([]);

    for (const entry of MINUTES_FIELD_ALLOWLIST) {
      expect(entry.reason.length, `${entry.field} 必须写清保留理由`).toBeGreaterThan(6);
      expect(hits.has(entry.field), `白名单僵尸条目：${entry.field} 已不存在`).toBe(true);
    }
  });
});