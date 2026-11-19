/**
 * v2.1 自适应日计划引擎 —— 纯函数。
 *
 * 与 v2.0 `domain/plan.ts` 的关系：
 * - `plan.ts` 是「240 分钟固定 9 模块」的增量分配器，v2.0 契约不可变，保留；
 * - 本文件是 v2.1「按当日预算动态生成」的新引擎，**不改动 plan.ts 的任何语义**；
 *   当预算恰好为 240 且未启用 v2.1 特性时，两者输出的模块集合可对齐（用于回归）。
 *
 * 硬约束（需求手册 §5.3 / §15.1）：
 * 1. `Σ 任务 minutes <= 预算`，绝不越界；预算 0 = 休息日 → 不生成任何任务；
 * 2. `estimated_minutes > 0`，且任何任务 `>= 最小粒度`；低于粒度的技能份额
 *    **不生成碎片**，转入周轮换（`weeklyRotation`）；
 * 3. P0 复习优先，但最多占预算的 `p0CapRatio`，且必须为阶段核心留出 `coreMinRatio`，
 *    避免「每天只剩复习」；
 * 4. 短时预算（<= SHORT_PLAN_MAX_MINUTES）只安排一项主技能，不强行铺满四项；
 * 5. 不为填满预算而创建低价值任务：只有预算充足且确有剩余时才加 P3 拓展；
 * 6. 档位模板（`BUDGET_TEMPLATES`）是**起点**而非课表：技能池再按阶段配比 + 粒度二次分配。
 */

import {
  BUDGET_MAINTENANCE_MAX,
  BUDGET_TEMPLATES,
  CORE_MIN_RATIO,
  CUSTOM_TEMPLATE_FOUNDATION_RATIO,
  CUSTOM_TEMPLATE_REVIEW_RATIO,
  GRAMMAR_CAP_RATIO,
  MIN_TASK_MINUTES,
  MODULE_META,
  MODULE_TO_PRIMARY,
  MODULE_TRACK,
  P0_CAP_RATIO,
  S0_MODULES,
  SHORT_PLAN_MAX_MINUTES,
  type BudgetTemplate,
} from '../constants';
import { splitByAllocation } from './allocation';
import type {
  AllocationSkill,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillAllocation,
  SkillId,
  StageCode,
  TaskPriority,
  TaskSourceKind,
} from '../types';

/** 引擎产出的一条计划项。 */
export interface AdaptivePlanItem {
  module: ModuleId;
  skill: SkillId;
  minutes: number;
  sortOrder: number;
  track: LearningTrack;
  primarySkill: PrimarySkill;
  priority: TaskPriority;
  sourceKind: TaskSourceKind;
  splittable: boolean;
  minChunkMinutes: number;
  /** 给用户看的一句安排理由（UI 原样展示，不编造数据）。 */
  rationale: string;
}

/** 未能排入当天的部分（含原因），进入 backlog 或转周轮换。 */
export interface BacklogEntry {
  kind: 'REVIEW' | 'SKILL_ROTATION' | 'EXTENDED' | 'CORE_DEFERRED';
  label: string;
  minutes: number;
  reason: string;
}

/** 到期复习的聚合输入。 */
export interface DueReviewInput {
  /** 到期 + 逾期复习的预估总分钟。 */
  estMinutes: number;
  /** 条数（用于文案，不影响算法）。 */
  count: number;
  /** 最长的逾期天数（0 = 全部今天到期）。 */
  maxOverdueDays: number;
}

export interface AdaptivePlanInput {
  /** 当日有效预算（分钟）。0 或不传 isRestDay 时按休息日处理。 */
  budgetMinutes: number;
  isRestDay?: boolean;
  stageCode: StageCode;
  /** 阶段四技能目标配比；不传时按 25/25/25/25（仅用于技能池切分）。 */
  allocation?: SkillAllocation | null;
  /** 到期/逾期复习。 */
  dueReviews?: DueReviewInput | null;
  /** 有证据的弱项技能（按强度降序，最多 3 项）。 */
  weakSkills?: AllocationSkill[];
  /** 本周各技能相对目标的缺口分钟（正数 = 还欠多少）。 */
  weeklyGap?: Partial<Record<AllocationSkill, number>> | null;
  /** 最小任务粒度，默认取常量。 */
  minTaskMinutes?: number;
  /** 预算档位编码（用于取模板）；不传按分钟数反推。 */
  tierCode?: string | null;
  /** P0 占预算上限比例，默认 0.6。 */
  p0CapRatio?: number;
  /** 阶段核心最低保障比例，默认 0.3。 */
  coreMinRatio?: number;
  /**
   * 本次不再生成的模块：重排时传「当日已做过 / 正在做的模块」，
   * S0 阶段传「已完成的基线诊断」。省下的时间流向技能池，不重复排同一项。
   */
  skipModules?: ModuleId[];
}

export interface AdaptivePlanResult {
  ok: true;
  items: AdaptivePlanItem[];
  totalPlannedMinutes: number;
  priorityMinutes: Record<TaskPriority, number>;
  backlog: BacklogEntry[];
  warnings: string[];
  /** 低于最小粒度而未生成的技能份额（转周轮换）。 */
  weeklyRotation: Partial<Record<AllocationSkill, number>>;
}

export type AdaptivePlanError = { ok: false; code: 'INVALID_BUDGET' | 'NEGATIVE_MINUTES' };

/** 模块 → 四技能 / 轨道（与 constants 保持一致，此处内联避免循环依赖）。 */
const SKILL_MODULE: Record<AllocationSkill, { module: ModuleId; skill: SkillId; track: LearningTrack }> = {
  LISTENING: { module: 'LISTENING', skill: 'LISTENING', track: 'GENERAL_ENGLISH' },
  READING: { module: 'READING', skill: 'READING', track: 'GENERAL_ENGLISH' },
  SPEAKING: { module: 'SPEAKING', skill: 'SPEAKING', track: 'GENERAL_ENGLISH' },
  WRITING: { module: 'WRITING', skill: 'WRITING', track: 'GENERAL_ENGLISH' },
};

/** 取该档模板；自定义预算按比例切分。 */
export function templateFor(budgetMinutes: number, tierCode?: string | null): BudgetTemplate {
  const preset = tierCode ? BUDGET_TEMPLATES[tierCode] : undefined;
  if (preset) return preset;

  const budget = Math.max(0, Math.round(budgetMinutes));
  const review = Math.max(0, Math.round(budget * CUSTOM_TEMPLATE_REVIEW_RATIO));
  const foundation = Math.max(0, Math.round(budget * CUSTOM_TEMPLATE_FOUNDATION_RATIO));
  const skill = Math.max(0, budget - review - foundation);
  return { foundation, skill, review };
}

/** 取整到最小粒度（向下），保证不超过预算。 */
function floorTo(minutes: number, granularity: number): number {
  if (minutes <= 0) return 0;
  return Math.floor(minutes / granularity) * granularity;
}

/** 收尾：总量复核 + 维护模式/余量提示，统一从一个出口返回，避免多处漏校验。 */
function finishPlan(
  budget: number,
  items: AdaptivePlanItem[],
  priorityMinutes: Record<TaskPriority, number>,
  backlog: BacklogEntry[],
  warnings: string[],
  weeklyRotation: Partial<Record<AllocationSkill, number>>,
): AdaptivePlanResult | AdaptivePlanError {
  const totalPlannedMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
  if (totalPlannedMinutes > budget) {
    // 防御性分支：理论上不可达（每步都先 min(remaining)）
    return { ok: false, code: 'NEGATIVE_MINUTES' };
  }
  if (budget <= BUDGET_MAINTENANCE_MAX) {
    warnings.push('应急维护模式：15 分钟以内的安排只维持记忆连续性，不视为完整学习日。');
  }
  const remaining = budget - totalPlannedMinutes;
  if (remaining > 0) {
    warnings.push(`已安排 ${totalPlannedMinutes} / ${budget} 分钟，剩余 ${remaining} 分钟不强行填满。`);
  }
  return { ok: true, items, totalPlannedMinutes, priorityMinutes, backlog, warnings, weeklyRotation };
}

/**
 * 生成自适应日计划。
 *
 * 执行顺序（不可调换）：
 * ① 预算校验 → ② 休息日短路 → ③ 取模板 → ④ P0 切片（受上限与核心保障双重约束）
 * → ⑤ 基础支持模块 → ⑥ 技能池按配比 + 粒度切分 → ⑦ 复盘/拓展收尾 → ⑧ 总量复核。
 */
export function generateAdaptivePlan(input: AdaptivePlanInput): AdaptivePlanResult | AdaptivePlanError {
  const warnings: string[] = [];
  const backlog: BacklogEntry[] = [];
  const weeklyRotation: Partial<Record<AllocationSkill, number>> = {};

  const budget = Math.round(input.budgetMinutes);
  if (!Number.isFinite(budget) || budget < 0) {
    return { ok: false, code: 'INVALID_BUDGET' };
  }
  const granularity = Math.max(1, Math.round(input.minTaskMinutes ?? MIN_TASK_MINUTES));

  const empty: AdaptivePlanResult = {
    ok: true,
    items: [],
    totalPlannedMinutes: 0,
    priorityMinutes: { P0: 0, P1: 0, P2: 0, P3: 0 },
    backlog,
    warnings,
    weeklyRotation,
  };

  // ② 休息日 / 零预算：不生成强制任务，复习留在 backlog
  if (input.isRestDay || budget === 0) {
    if ((input.dueReviews?.estMinutes ?? 0) > 0) {
      backlog.push({
        kind: 'REVIEW',
        label: '到期复习',
        minutes: input.dueReviews?.estMinutes ?? 0,
        reason: '休息日不安排学习任务；复习保留在 backlog，次日按 P0 优先处理',
      });
    }
    warnings.push('休息日 / 零预算：不生成学习任务，本次不计为学习失败。');
    return empty;
  }

  const p0CapRatio = input.p0CapRatio ?? P0_CAP_RATIO;
  const coreMinRatio = input.coreMinRatio ?? CORE_MIN_RATIO;

  // ③ 模板
  const template = templateFor(budget, input.tierCode);
  let remaining = budget;
  const items: AdaptivePlanItem[] = [];
  const priorityMinutes: Record<TaskPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };

  const push = (item: Omit<AdaptivePlanItem, 'sortOrder'>) => {
    items.push({ ...item, sortOrder: items.length });
    priorityMinutes[item.priority] += item.minutes;
    remaining -= item.minutes;
  };

  // ④ P0 切片：min(到期复习量, 预算×p0上限, 预算−核心保障)
  const dueMinutes = Math.max(0, Math.round(input.dueReviews?.estMinutes ?? 0));
  const coreReserve = Math.round(budget * coreMinRatio);
  const p0Cap = Math.floor(budget * p0CapRatio);
  const p0Available = Math.max(0, Math.min(dueMinutes, p0Cap, budget - coreReserve));
  const p0Minutes = floorTo(p0Available, granularity);

  if (p0Minutes > 0) {
    const overdue = input.dueReviews?.maxOverdueDays ?? 0;
    push({
      module: 'P0_REVIEW',
      skill: 'META',
      minutes: p0Minutes,
      track: 'GENERAL_ENGLISH',
      primarySkill: 'FOUNDATION',
      priority: 'P0',
      sourceKind: 'REVIEW',
      splittable: true,
      minChunkMinutes: granularity,
      rationale:
        overdue > 0
          ? `到期/逾期复习 ${dueMinutes} 分钟，按逾期风险先安排 ${p0Minutes} 分钟（${input.dueReviews?.count ?? 0} 项待复习）`
          : `今天到期复习 ${dueMinutes} 分钟，安排 ${p0Minutes} 分钟`,
    });
  }
  if (dueMinutes > p0Minutes) {
    backlog.push({
      kind: 'REVIEW',
      label: '到期复习（剩余部分）',
      minutes: dueMinutes - p0Minutes,
      reason: `超出当日 P0 上限（${p0Cap} 分钟）或阶段核心保障所需，按逾期风险分批，未安排部分留在 backlog`,
    });
  }

  const skip = new Set<ModuleId>(input.skipModules ?? []);

  // S0 准备阶段：沿用 v2.0 语义，只排基线诊断任务。
  // 基线诊断不可拆分 —— 做半截的诊断填不了验收清单初值，预算不足就整项顺延。
  if (input.stageCode === 'S0_PREP') {
    for (const module of S0_MODULES) {
      if (skip.has(module)) continue;
      const meta = MODULE_META[module];
      const want = meta.defaultMinutes;
      if (remaining < want) {
        backlog.push({
          kind: 'CORE_DEFERRED',
          label: meta.labelZh,
          minutes: want,
          reason: `基线诊断需要完整 ${want} 分钟，当日剩余 ${Math.max(0, remaining)} 分钟不足，顺延到下一个可用日期`,
        });
        continue;
      }
      push({
        module,
        skill: meta.skill,
        minutes: want,
        track: MODULE_TRACK[module],
        primarySkill: MODULE_TO_PRIMARY[module],
        priority: 'P1',
        sourceKind: 'CORE',
        splittable: false,
        minChunkMinutes: want,
        rationale: '基线诊断：用于填写阶段验收清单初值，需一次完成',
      });
    }
    if (items.length === 0) {
      warnings.push('阶段零只做基线诊断；当日预算不足一项完整诊断，未生成任务，改做复习或直接休息都不计为失败。');
    } else {
      warnings.push('阶段零只生成基线诊断任务，暂不生成技能训练计划。');
    }
    return finishPlan(budget, items, priorityMinutes, backlog, warnings, weeklyRotation);
  }

  // ⑤ 基础支持模块（词汇复习 + 语法/句子），从模板 foundation 中切。
  //    取整余量不丢弃：并入技能池（技能池才是需要按配比分配的部分）。
  //    S1 阶段语法类不得超过当日预算的 20%（v2.0 口径），超出的部分让给词汇。
  const foundationTarget = floorTo(Math.min(template.foundation, remaining), granularity);
  const grammarCap =
    input.stageCode === 'S1_A0_A2'
      ? floorTo(Math.floor(budget * GRAMMAR_CAP_RATIO), granularity)
      : foundationTarget;
  const grammarWanted = floorTo(
    foundationTarget - floorTo(foundationTarget * 0.6, granularity),
    granularity,
  );
  const grammarMinutes = skip.has('GRAMMAR') ? 0 : Math.min(grammarWanted, grammarCap);
  const vocabMinutes = skip.has('VOCAB_REVIEW')
    ? 0
    : floorTo(foundationTarget - grammarMinutes, granularity);
  if (vocabMinutes >= granularity) {
    push({
      module: 'VOCAB_REVIEW',
      skill: 'VOCAB',
      minutes: vocabMinutes,
      track: 'GENERAL_ENGLISH',
      primarySkill: 'FOUNDATION',
      priority: 'P1',
      sourceKind: 'CORE',
      splittable: true,
      minChunkMinutes: granularity,
      rationale: '词汇复习：先旧词再新词，属于支持性时间，不进入四技能分母',
    });
  }
  if (grammarMinutes >= granularity) {
    push({
      module: 'GRAMMAR',
      skill: 'GRAMMAR',
      minutes: grammarMinutes,
      track: 'GENERAL_ENGLISH',
      primarySkill: 'FOUNDATION',
      priority: 'P1',
      sourceKind: 'CORE',
      splittable: true,
      minChunkMinutes: granularity,
      rationale: '语法/句型：当前阶段核心结构训练',
    });
  }

  // ⑥ 复盘/计划先占位（在技能池之前确定，避免技能池把复盘时间吃掉）
  const reviewTarget = floorTo(Math.min(template.review, remaining), granularity);
  if (reviewTarget >= granularity && !skip.has('REVIEW_PLAN')) {
    push({
      module: 'REVIEW_PLAN',
      skill: 'META',
      minutes: reviewTarget,
      track: 'GENERAL_ENGLISH',
      primarySkill: 'FOUNDATION',
      priority: 'P1',
      sourceKind: 'CORE',
      splittable: false,
      minChunkMinutes: reviewTarget,
      rationale: '复盘与排下一天计划（管理时间，不进入四技能分母）',
    });
  }

  // ⑦ 技能池 = 预算 − 已安排（P0 + 基础 + 复盘 + 拓展）。按阶段配比切分并做余数补块，
  //    保证不浪费预算、也不产生低于粒度的碎片。
  const extensivePlanned = 0; // 拓展在技能池之后分配
  const skillPool = floorTo(Math.max(0, remaining - extensivePlanned), granularity);
  if (skillPool > 0) {
    const target: SkillAllocation =
      input.allocation ?? { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 };
    const weak = new Set(input.weakSkills ?? []);
    const gap = input.weeklyGap ?? {};
    const shortPlan = budget <= SHORT_PLAN_MAX_MINUTES;
    const split = splitByAllocation(skillPool, target);

    // 短时预算：整个技能池交给单一主技能。
    // 不能先按四项切开再挑一项 —— 那样其余三块会被丢掉，30 分钟档只剩 5 分钟主技能。
    // 主技能选择顺序：本周缺口最大 → 阶段配比最高 → 有证据的弱项。
    // 缺口排第一位是周轮换的实现方式：否则每天都会选到配比最高的那一项。
    if (shortPlan) {
      const skills: AllocationSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];
      const gapOf = (skill: AllocationSkill) => gap[skill] ?? 0;
      const mainSkill = [...skills].sort(
        (a, b) =>
          gapOf(b) - gapOf(a) ||
          target[b] - target[a] ||
          (weak.has(b) ? 1 : 0) - (weak.has(a) ? 1 : 0),
      )[0];
      const meta = SKILL_MODULE[mainSkill];
      const isWeak = weak.has(mainSkill);
      push({
        module: meta.module,
        skill: meta.skill,
        minutes: skillPool,
        track: meta.track,
        primarySkill: mainSkill,
        priority: isWeak ? 'P2' : 'P1',
        sourceKind: isWeak ? 'WEAKNESS' : 'CORE',
        splittable: true,
        minChunkMinutes: granularity,
        rationale: `短时预算把整块技能时间给主技能 ${mainSkill}，其余技能通过本周轮换覆盖`,
      });
      // 其余技能按配比本应得到的分钟数记入周轮换（单位是分钟，不是百分比）
      let rotationTotal = 0;
      for (const skill of skills) {
        if (skill === mainSkill || split[skill] <= 0) continue;
        weeklyRotation[skill] = split[skill];
        rotationTotal += split[skill];
      }
      if (rotationTotal > 0) {
        backlog.push({
          kind: 'SKILL_ROTATION',
          label: '未安排技能份额',
          minutes: rotationTotal,
          reason: '短时预算只安排一项主技能，其余技能转入本周轮换',
        });
      }
      return finishPlan(budget, items, priorityMinutes, backlog, warnings, weeklyRotation);
    }

    // 每项先向下取整到粒度，余数用于补块（最大余数法，平局按固定顺序）
    const raw = (['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as AllocationSkill[]).map(
      (skill) => {
        const exact = split[skill];
        const base = floorTo(exact, granularity);
        return { skill, exact, base, remain: exact - base };
      },
    );
    let assigned = raw.reduce((sum, row) => sum + row.base, 0);
    const leftoverBlocks = Math.max(0, Math.floor((skillPool - assigned) / granularity));
    const ordered = [...raw].sort(
      (a, b) => b.remain - a.remain || raw.findIndex((r) => r.skill === a.skill) - raw.findIndex((r) => r.skill === b.skill),
    );
    for (let i = 0; i < leftoverBlocks; i += 1) {
      const row = ordered[i % ordered.length];
      row.base += granularity;
      assigned += granularity;
    }

    // 份额不足粒度的一律转入周轮换（不生成碎片）
    for (const row of raw) {
      if (row.base < granularity) {
        weeklyRotation[row.skill] = (weeklyRotation[row.skill] ?? 0) + row.exact;
        continue;
      }
      const meta = SKILL_MODULE[row.skill];
      const isWeak = weak.has(row.skill);
      const gapMinutes = Math.max(0, Math.round(gap[row.skill] ?? 0));
      push({
        module: meta.module,
        skill: meta.skill,
        minutes: row.base,
        track: meta.track,
        primarySkill: row.skill,
        priority: isWeak ? 'P2' : 'P1',
        sourceKind: isWeak ? 'WEAKNESS' : 'CORE',
        splittable: true,
        minChunkMinutes: granularity,
        rationale: isWeak
          ? `有证据的弱项：${row.skill}，本周缺口约 ${gapMinutes} 分钟`
          : `${row.skill} 阶段核心训练`,
      });
    }

    // 未被采用的份额一律说明去向，不静默丢弃
    const rotationTotal = Object.values(weeklyRotation).reduce((sum, value) => sum + (value ?? 0), 0);
    if (rotationTotal > 0) {
      backlog.push({
        kind: 'SKILL_ROTATION',
        label: '未安排技能份额',
        minutes: rotationTotal,
        reason: '按配比切分后低于最小任务粒度，不生成碎片任务，转入本周轮换',
      });
    }
  }

  // ⑧ 拓展（P3）：仅当预算充足（>= 120）且仍有 >= 2 个粒度的剩余
  if (budget >= 120 && remaining >= granularity * 2) {
    const extensive = Math.floor(remaining / granularity) * granularity;
    push({
      module: 'EXTENSIVE',
      skill: 'LISTENING_EXT',
      minutes: extensive,
      track: 'GENERAL_ENGLISH',
      primarySkill: 'FOUNDATION',
      priority: 'P3',
      sourceKind: 'EXTENDED',
      splittable: true,
      minChunkMinutes: granularity,
      rationale: '泛听泛读（独立成桶，不并入精听精读）',
    });
  }

  return finishPlan(budget, items, priorityMinutes, backlog, warnings, weeklyRotation);
}

/** 当日计划总分钟（供 UI 与校验复用）。 */
export function plannedMinutesOf(items: { minutes: number }[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.minutes), 0);
}

/** 预算利用口径：`planned / budget`；预算为 0 → null（显示 N/A）。 */
export function budgetUsageRatio(planned: number, budget: number): number | null {
  if (budget <= 0) return null;
  return planned / budget;
}
