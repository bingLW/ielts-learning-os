/**
 * AI 建议生成 —— 纯函数（PRD §10 决策 / R9）。
 *
 * 这不是真的「大模型」，而是**确定性规则引擎**：从真实聚合数据出发，
 * 产出「结论 + 依据」，绝不编造成绩。三条刻意设计：
 *
 * 1. 每条建议的 `basis` **必须非空**，且只引用真实数字 —— UI 强制展示，
 *    让「这条建议依据什么」永远可查（R9：AI 建议与成绩物理分离）；
 * 2. **无数据不生成**：输入为空/为 null 时返回空数组，而不是编一条「看起来对」的建议；
 * 3. 建议是**参考性**的，不写入任何成绩表、不自动改配比、不自动切换阶段 ——
 *    「需用户确认」由 action/UI 层的落库 + 采纳交互保证，领域层只负责算。
 */

import { ALLOCATION_SKILLS, PRIMARY_SKILL_LABEL_ZH } from '../constants';
import { formatDurationZh, formatPercent, formatPercentOf100 } from '../format';
import type { SkillAllocation, WeaknessDto } from '../types';
import { allocationDeviation, skillShare, type PrimarySkillMinutes } from './allocation';
import type { WeeklyRawInput } from './weekly';

/** 一条建议草稿。`basis` 是强制非空的数据依据（引用真实数字）。 */
export interface SuggestionDraft {
  title: string;
  body: string;
  basis: string;
}

// ───────────────────────── 薄弱项建议（WEAKNESS） ─────────────────────────

/**
 * 从弱项排序结果生成建议。
 *
 * - 每个达标弱项（Top N）生成一条，basis 直接引用弱项的 `evidence`（错题率三元组）；
 * - 样本不足的维度单独汇总成一条「先补数据」建议，绝不假装已经知道谁弱。
 */
export function buildWeaknessSuggestions(
  ranked: WeaknessDto[],
  insufficient: WeaknessDto[],
): SuggestionDraft[] {
  const drafts: SuggestionDraft[] = [];

  for (const item of ranked.slice(0, 3)) {
    drafts.push({
      title: `优先补强「${item.name}」`,
      body: item.actionHint,
      basis: `${item.name}：${item.evidence}`,
    });
  }

  if (insufficient.length > 0) {
    const names = insufficient.slice(0, 5).map((item) => item.name).join('、');
    drafts.push({
      title: '部分维度样本不足，暂不排序',
      body: '先积累到样本阈值（每题 ≥10 道）再判断薄弱项，避免误判。',
      basis: `数据不足的维度：${names}（共 ${insufficient.length} 项）`,
    });
  }

  return drafts;
}

// ───────────────────────── 周报建议（WEEKLY） ─────────────────────────

/**
 * 从周报原始输入生成建议（引用 13 项指标里的真实数字）。
 *
 * 规则逐条独立、可复现：完成率、词汇抽测、逾期复习、时长环比、错误类别。
 * 每一条都只在**数据存在**时才产出。
 */
export function buildWeeklySuggestions(input: WeeklyRawInput): SuggestionDraft[] {
  const drafts: SuggestionDraft[] = [];

  // 完成率：加权完成率 < 60% 才提醒（避免「周末没过完」误报）。
  if (input.completionByTime !== null && input.completionByTime < 0.6) {
    drafts.push({
      title: '本周计划完成率偏低',
      body: '下周下调计划时长到可完成区间，或优先清理逾期任务。',
      basis: `本周按时长加权完成率 ${formatPercent(input.completionByTime)}`,
    });
  }

  // 词汇抽测：<80% 下调新词量（与 vocab 页同一门槛）。
  if (input.vocab.quizAccuracy !== null && input.vocab.quizAccuracy < 0.8) {
    drafts.push({
      title: '词汇抽测正确率不足 80%',
      body: '下周减少新词量、提高旧词复习占比。',
      basis: `本周词汇抽测加权正确率 ${formatPercent(input.vocab.quizAccuracy)}`,
    });
  }

  // 逾期复习。
  if (input.review.overdue > 0) {
    drafts.push({
      title: '存在逾期复习任务',
      body: '优先清理逾期任务，避免复习间隔被拉长导致遗忘。',
      basis: `本周逾期未做复习 ${input.review.overdue} 条`,
    });
  }

  // 时长环比：有数据才比较，净时长明显下滑才提醒。
  if (input.dataDays > 0 && input.prevNetMinutes > 0) {
    const drop = input.prevNetMinutes - input.netMinutes;
    if (drop > 0 && input.netMinutes < input.prevNetMinutes * 0.7) {
      drafts.push({
        title: '净学习时长环比下滑',
        body: '检查是否有连续空窗日，尽量保持每天有最短可执行的学习。',
        basis: `本周 ${formatDurationZh(input.netMinutes)}，上周 ${formatDurationZh(
          input.prevNetMinutes,
        )}`,
      });
    }
  }

  // 主要错误类别：存在才生成。
  if (input.mistakes.topCategoryLabel) {
    drafts.push({
      title: `主要错误类别：${input.mistakes.topCategoryLabel}`,
      body: '在语法诊断里优先复测该类别对应的单元。',
      basis: `本周错题出现次数最多的类别为「${input.mistakes.topCategoryLabel}」（新增 ${input.mistakes.added} 道）`,
    });
  }

  return drafts;
}

// ───────────────────────── 计划建议（PLAN） ─────────────────────────

/** 配比偏离阈值（百分点）：低于它视为「接近」，不生成建议。 */
export const PLAN_DEVIATION_MIN_PT = 5;

/**
 * 从四技能实际 vs 建议配比生成计划调整建议。
 *
 * 只对「偏离超过阈值」的技能生成建议；分母为 0（没有四项训练数据）时返回空数组。
 */
export function buildPlanSuggestions(
  minutes: PrimarySkillMinutes,
  target: SkillAllocation,
): SuggestionDraft[] {
  const share = skillShare(minutes);
  if (share.denominator === 0) return [];

  const deviation = allocationDeviation(minutes, target);
  if (!deviation) return [];

  const drafts: SuggestionDraft[] = [];

  for (const skill of ALLOCATION_SKILLS) {
    const dev = deviation[skill];
    const label = PRIMARY_SKILL_LABEL_ZH[skill];
    const actualPct = share.share[skill];
    const targetPct = target[skill];
    if (actualPct === null) continue;

    if (dev <= -PLAN_DEVIATION_MIN_PT) {
      drafts.push({
        title: `${label}投入偏低`,
        body: `下周计划为「${label}」追加时长，向阶段建议配比靠拢。`,
        basis: `${label}实际 ${formatPercent(actualPct)}，建议 ${formatPercentOf100(
          targetPct,
        )}（欠 ${Math.abs(Math.round(dev))}pt）`,
      });
    } else if (dev >= PLAN_DEVIATION_MIN_PT) {
      drafts.push({
        title: `${label}投入偏高`,
        body: `下周计划适当减少「${label}」时长，把时间让给欠配技能。`,
        basis: `${label}实际 ${formatPercent(actualPct)}，建议 ${formatPercentOf100(
          targetPct,
        )}（超 ${Math.round(dev)}pt）`,
      });
    }
  }

  return drafts;
}
