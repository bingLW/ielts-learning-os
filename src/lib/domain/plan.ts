/**
 * 每日计划生成与增量分配 —— 纯函数。
 *
 * 硬约束（PRD §6.2）：
 * - 基础版 240min / 9 模块，数值不可改；
 * - `REVIEW_PLAN` 恒 10min，不增不减；
 * - S1 阶段「语法类」= `GRAMMAR + SENTENCE` 合计 ≤ 总时长 × 20%
 *   （注意：不是只看 GRAMMAR —— 这是 20% 上限唯一的口径，见 `grammarMinutesOf`）；
 * - 单科增量上限：说/听/读 20min，其余 15min；SENTENCE 在 S1 不增、S2/S3 最多 +5；
 * - 增量优先给薄弱项 Top3（子项映射到父模块）；
 * - 增量容量之和承载不了 `dailyMinutes` 时**返回失败码**，绝不越界硬塞（`CAPACITY_EXCEEDED`）；
 * - 不变量：`Σminutes === dailyMinutes`，`sortOrder` 严格等于 SOP 主线顺序。
 * - S0 例外：只生成 3 个基线任务，合计 90min（PRD Q3）；`dailyMinutes` 仍需合法。
 *
 * v2.0 新增（三条，都不改变上面任何一条）：
 * - 每条计划项带 `track` 与 `primarySkill` 快照（轨道/技能是任务的属性，不是第二份记录）；
 * - 传入 `allocation` 时，在**保持四技能总分钟不变**的前提下把 L/R/S/W 调向目标配比
 *   （`rebalanceFourSkills`）。支持性模块分钟数完全不动，因此 `Σminutes` 与语法封顶不受影响；
 * - 未传 `allocation` 时行为与 v1.5 完全一致（向后兼容，旧测试无需改）。
 */

import {
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  EXTRA_CAP_DEFAULT,
  EXTRA_CAP_SKILL,
  GRAMMAR_CAP_RATIO,
  MODULE_META,
  MODULE_ORDER,
  MODULE_TO_PRIMARY,
  MODULE_TRACK,
  REVIEW_PLAN_FIXED,
  S0_MODULES,
  SENTENCE_EXTRA_CAP,
} from '../constants';
import type {
  DailyPlanItem,
  DomainError,
  LearningTrack,
  ModuleId,
  PrimarySkill,
  SkillAllocation,
  SkillId,
  StageCode,
  WeakModuleHint,
} from '../types';
import { rebalanceFourSkills } from './allocation';

/** S0 基线任务合计分钟（30 + 30 + 30）。 */
export const S0_TOTAL_MINUTES =
  MODULE_META.BASELINE_LISTEN.defaultMinutes +
  MODULE_META.BASELINE_READ.defaultMinutes +
  MODULE_META.BASELINE_OUTPUT.defaultMinutes;

/** 基础版 9 模块分钟数（= 240）。 */
export function basePlanMinutes(): Record<ModuleId, number> {
  const out = emptyAllocation();
  for (const module of MODULE_ORDER) {
    out[module] = MODULE_META[module].defaultMinutes;
  }
  return out;
}

/** 全 0 分配表（含 S0 三个模块键，保证类型完整）。 */
function emptyAllocation(): Record<ModuleId, number> {
  return {
    VOCAB_REVIEW: 0,
    GRAMMAR: 0,
    LISTENING: 0,
    READING: 0,
    SPEAKING: 0,
    WRITING: 0,
    SENTENCE: 0,
    REVIEW_PLAN: 0,
    EXTENSIVE: 0,
    MEDIATED: 0,
    P0_REVIEW: 0,
    BASELINE_LISTEN: 0,
    BASELINE_READ: 0,
    BASELINE_OUTPUT: 0,
    EVIDENCE_RETEST: 0,
  };
}

/** 某模块在给定阶段下的单日增量上限。 */
function moduleCapacity(module: ModuleId, stageCode: StageCode, totalMinutes: number): number {
  const base = basePlanMinutes()[module] ?? 0;
  switch (module) {
    case 'REVIEW_PLAN':
      return 0; // SOP 明确「保持 10 分钟」
    case 'SENTENCE':
      return stageCode === 'S1_A0_A2' ? 0 : SENTENCE_EXTRA_CAP;
    case 'GRAMMAR': {
      if (stageCode === 'S1_A0_A2') {
        // 20% 上限约束的是「语法类」= GRAMMAR + SENTENCE 的合计（PRD §6.2）。
        // 因此语法自身的增量容量必须先扣掉基础 SENTENCE 分钟数，
        // 否则语法一加就必然把合计顶过上限（缺陷 D4）。
        const cap = totalMinutes * GRAMMAR_CAP_RATIO;
        const baseSentence = basePlanMinutes().SENTENCE;
        return Math.max(0, Math.min(EXTRA_CAP_DEFAULT, Math.floor(cap - base - baseSentence)));
      }
      return EXTRA_CAP_DEFAULT;
    }
    case 'LISTENING':
    case 'READING':
    case 'SPEAKING':
      return EXTRA_CAP_SKILL;
    default:
      return EXTRA_CAP_DEFAULT;
  }
}

/**
 * 纯增量分配：把 `extra` 分钟分给 9 个模块，优先薄弱项，再按主线顺序轮转。
 *
 * 抽出来是为了可单测 —— 不依赖 DB、不依赖当前时间。
 */
export function allocateExtra(
  extra: number,
  base: Record<ModuleId, number>,
  weak: WeakModuleHint[],
  stageCode: StageCode,
): Record<ModuleId, number> {
  const result: Record<ModuleId, number> = { ...base };
  let remaining = Math.max(0, Math.round(extra));
  if (remaining === 0) return result;

  const baseTotal = MODULE_ORDER.reduce((sum, module) => sum + (base[module] ?? 0), 0);
  const totalMinutes = baseTotal + remaining;

  const capacityLeft: Record<string, number> = {};
  for (const module of MODULE_ORDER) {
    capacityLeft[module] = moduleCapacity(module, stageCode, totalMinutes);
  }

  // ① 薄弱项优先（权重降序、同模块去重）
  const seen = new Set<ModuleId>();
  const ordered = [...weak]
    .filter((hint) => MODULE_ORDER.includes(hint.module))
    .sort((a, b) => b.weight - a.weight)
    .filter((hint) => {
      if (seen.has(hint.module)) return false;
      seen.add(hint.module);
      return true;
    });

  for (const hint of ordered) {
    if (remaining <= 0) break;
    const room = capacityLeft[hint.module] ?? 0;
    if (room <= 0) continue;
    const give = Math.min(room, remaining);
    result[hint.module] += give;
    capacityLeft[hint.module] = room - give;
    remaining -= give;
  }

  // ② 剩余增量按 SOP 主线轮流分配（保证不会全塞给最后一个）
  let guard = 0;
  while (remaining > 0 && guard < 1000) {
    let progressed = false;
    for (const module of MODULE_ORDER) {
      if (remaining <= 0) break;
      const room = capacityLeft[module] ?? 0;
      if (room <= 0) continue;
      result[module] += 1;
      capacityLeft[module] = room - 1;
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
    guard += 1;
  }

  // ③ 容量用尽仍有剩余：**不再**把剩余分钟硬塞给听力 ——
  //    那会突破单科上限，也会让「20% 语法上限」这类硬约束形同虚设（缺陷 D9）。
  //    未落地的部分由 `generateDailyPlan` 通过总量校验发现，并返回 `CAPACITY_EXCEEDED`。
  return result;
}

/**
 * 把「语法封顶后腾出的分钟」按 SOP 主线顺序补给其他模块（受各自单科上限约束）。
 *
 * 只用于保持不变量 `Σminutes === dailyMinutes`：语法类被 20% 上限削减后，
 * 差额必须去别处，不能凭空消失。跳过 GRAMMAR / SENTENCE / REVIEW_PLAN（三者不可增）。
 *
 * @returns 仍然没分配完的分钟数（正常情况下为 0）
 */
function redistributeCappedMinutes(
  minutes: number,
  allocation: Record<ModuleId, number>,
  base: Record<ModuleId, number>,
  stageCode: StageCode,
  totalMinutes: number,
): number {
  let remaining = Math.max(0, Math.round(minutes));
  let guard = 0;
  while (remaining > 0 && guard < 1000) {
    let progressed = false;
    for (const module of MODULE_ORDER) {
      if (remaining <= 0) break;
      if (module === 'GRAMMAR' || module === 'SENTENCE' || module === 'REVIEW_PLAN') continue;
      const limit = (base[module] ?? 0) + moduleCapacity(module, stageCode, totalMinutes);
      if ((allocation[module] ?? 0) >= limit) continue;
      allocation[module] += 1;
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
    guard += 1;
  }
  return remaining;
}

/** 日计划生成的失败返回（domain 层不 throw，一律用返回值表达）。 */
export type DailyPlanError =
  | DomainError<'MINUTES_OUT_OF_RANGE'>
  | { ok: false; code: 'CAPACITY_EXCEEDED'; error: string };

/** 日计划生成的成功返回。 */
export interface DailyPlanResult {
  ok: true;
  items: DailyPlanItem[];
  totalMinutes: number;
  warnings: string[];
}

/**
 * 生成当日计划。
 *
 * 执行顺序（不可调换）：
 * ① `dailyMinutes` 范围校验 → ② S0 特例 → ③ 增量分配（容量不足即失败）
 * → ④ S1 语法类 20% 封顶（差额转给其他模块）
 * → ⑤ **四技能配平**（v2.0，仅在传入 `allocation` 时执行；总分钟不变）
 * → ⑥ 总量不变量兜底
 *
 * @returns 成功时携带 items 与 warnings；失败返回失败码（不抛异常）
 */
export function generateDailyPlan(input: {
  dailyMinutes: number;
  stageCode: StageCode;
  weakTop3?: WeakModuleHint[];
  /** v2.0：目标四技能配比。不传则保持 v1.5 行为（不做配平）。 */
  allocation?: SkillAllocation | null;
}): DailyPlanResult | DailyPlanError {
  const { stageCode } = input;
  const warnings: string[] = [];

  // ① 范围校验放在 S0 之前：S0 虽然不使用 dailyMinutes，但入参本身必须合法，
  //    否则 `dailyMinutes: 100` 这类脏数据会被静默接受（缺陷 D8）。
  const dailyMinutes = Math.round(input.dailyMinutes);
  if (
    !Number.isFinite(dailyMinutes) ||
    dailyMinutes < DAILY_MINUTES_MIN ||
    dailyMinutes > DAILY_MINUTES_MAX
  ) {
    return { ok: false, code: 'MINUTES_OUT_OF_RANGE' };
  }

  // ② S0：只出 3 个基线任务（不使用 dailyMinutes，合计 90 分钟）
  if (stageCode === 'S0_PREP') {
    const items: DailyPlanItem[] = S0_MODULES.map((module, index) => ({
      module,
      skill: MODULE_META[module].skill,
      minutes: MODULE_META[module].defaultMinutes,
      sortOrder: index,
      track: MODULE_TRACK[module],
      primarySkill: MODULE_TO_PRIMARY[module],
    }));
    warnings.push(
      `阶段零只生成 3 个基线诊断任务（合计 ${S0_TOTAL_MINUTES} 分钟），用于填写验收清单初值；暂不生成 9 模块计划。`,
    );
    return { ok: true, items, totalMinutes: S0_TOTAL_MINUTES, warnings };
  }

  const base = basePlanMinutes();
  const baseTotal = MODULE_ORDER.reduce((sum, module) => sum + base[module], 0);
  const extra = dailyMinutes - baseTotal;

  const allocation =
    extra > 0 ? allocateExtra(extra, base, input.weakTop3 ?? [], stageCode) : { ...base };
  // 复盘恒 10
  allocation.REVIEW_PLAN = REVIEW_PLAN_FIXED;

  // ③ 增量必须全部落地：Σ 少了说明「单科增量上限之和」承载不了这么多分钟，
  //    此时明确失败，而不是把它偷偷塞给听力突破上限（缺陷 D9）。
  let sum = MODULE_ORDER.reduce((total, module) => total + allocation[module], 0);

  // 防御性分支：当前规格下不可达。
  // 合法区间 240–300 → extra ≤ 60；而单科增量容量总和的下限为
  // S1 = 105（240/270 时；300 时语法容量 +5 变 110）、S2/S3 = 125，60 远小于它们。
  // 保留此分支是为了防止未来放开 DAILY_MINUTES_MAX 或收紧单科上限时静默越界分配。
  // 若未来放宽每日上限，必须同步补充 plan.test.ts 的 CAPACITY_EXCEEDED 用例。
  if (extra > 0 && sum !== dailyMinutes) {
    return {
      ok: false,
      code: 'CAPACITY_EXCEEDED',
      error: `当日 ${dailyMinutes} 分钟超出现阶段单科增量上限能承载的总量（已分配 ${sum} 分钟），请缩短可用时长或调整阶段`,
    };
  }

  // ④ S1：语法类（GRAMMAR + SENTENCE）合计 ≤ 当日总时长 20%
  if (stageCode === 'S1_A0_A2') {
    const cap = Math.floor(dailyMinutes * GRAMMAR_CAP_RATIO);
    const grammarLike = allocation.GRAMMAR + allocation.SENTENCE;
    if (grammarLike > cap) {
      const excess = grammarLike - cap;
      // 只削语法本体：SENTENCE 在 S1 恒为基础值 15 分钟，不再下调
      allocation.GRAMMAR = Math.max(0, allocation.GRAMMAR - excess);
      const leftover = redistributeCappedMinutes(
        excess,
        allocation,
        base,
        stageCode,
        dailyMinutes,
      );
      // 极端情况下其他模块也没有余量时，最后才落到听力（保证 Σ 不变量）
      if (leftover > 0) allocation.LISTENING += leftover;
      warnings.push(
        `阶段一语法类任务（语法 + 句子成分）合计上限为当日总时长的 20%（约 ${cap} 分钟），已封顶并把腾出的 ${excess} 分钟转给其他模块。`,
      );
      sum = MODULE_ORDER.reduce((total, module) => total + allocation[module], 0);
    }
  }

  // ⑤ v2.0 四技能配平：只调整 L/R/S/W 之间的分配，四者总分钟严格不变。
  //    单独抽出来是因为它必须发生在语法封顶**之后**：封顶会把分钟转给听力，
  //    若先配平再封顶，封顶那一步又会把配比打乱。
  const target = input.allocation ?? null;
  if (target) {
    const current: Record<'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING', number> = {
      LISTENING: allocation.LISTENING,
      READING: allocation.READING,
      SPEAKING: allocation.SPEAKING,
      WRITING: allocation.WRITING,
    };
    const before = { ...current };
    const rebalanced = rebalanceFourSkills(current, target);

    allocation.LISTENING = rebalanced.minutes.LISTENING;
    allocation.READING = rebalanced.minutes.READING;
    allocation.SPEAKING = rebalanced.minutes.SPEAKING;
    allocation.WRITING = rebalanced.minutes.WRITING;

    // 配平只做四者内部搬运，Σ 必然不变；这里仍复核一次，防未来改动破坏不变量
    const beforeSum =
      before.LISTENING + before.READING + before.SPEAKING + before.WRITING;
    const afterSum =
      allocation.LISTENING + allocation.READING + allocation.SPEAKING + allocation.WRITING;
    if (beforeSum !== afterSum) {
      allocation.LISTENING = before.LISTENING;
      allocation.READING = before.READING;
      allocation.SPEAKING = before.SPEAKING;
      allocation.WRITING = before.WRITING;
      warnings.push('四技能配平未能保持总分钟不变，已回退到配平前的分配。');
    } else {
      const moved =
        Math.abs(allocation.LISTENING - before.LISTENING) +
        Math.abs(allocation.READING - before.READING) +
        Math.abs(allocation.SPEAKING - before.SPEAKING) +
        Math.abs(allocation.WRITING - before.WRITING);
      if (moved > 0) {
        warnings.push(
          `已按目标配比（听 ${target.LISTENING}% / 读 ${target.READING}% / 说 ${target.SPEAKING}% / 写 ${target.WRITING}%）在四项技能内部调整 ${moved / 2} 分钟；支持性模块（词汇/语法/句子/复盘/泛练）分钟数不受影响。`,
        );
      }
    }
    sum = MODULE_ORDER.reduce((total, module) => total + allocation[module], 0);
  }

  // ⑥ 总量不变量兜底：Σ 必须等于 dailyMinutes
  if (sum !== dailyMinutes) {
    const diff = dailyMinutes - sum;
    allocation.LISTENING = Math.max(0, allocation.LISTENING + diff);
    warnings.push('增量分配未通过总量校验，已按 SOP 主线回退到等比例分配。');
  }

  const items: DailyPlanItem[] = MODULE_ORDER.map((module, index) => ({
    module,
    skill: MODULE_META[module].skill as SkillId,
    minutes: allocation[module],
    sortOrder: index,
    track: MODULE_TRACK[module] as LearningTrack,
    primarySkill: MODULE_TO_PRIMARY[module] as PrimarySkill,
  })).filter((item) => item.minutes > 0);

  if (extra > 0 && (input.weakTop3 ?? []).some((hint) => hint.module === 'GRAMMAR')) {
    warnings.push('薄弱项包含语法，但语法增量受阶段 20% 上限约束，已优先分配给其他薄弱项。');
  }

  const totalMinutes = items.reduce((total, item) => total + item.minutes, 0);
  return { ok: true, items, totalMinutes, warnings };
}

/**
 * 当日「语法类」任务合计 = GRAMMAR + SENTENCE（含 SENTENCE，用于 UI 提示是否超 20%）。
 *
 * 语义**不可拆分**：S1 的 20% 上限同时约束这两类，`generateDailyPlan` 封顶时
 * 用的也是同一个口径，否则页面判定与生成逻辑会互相打架（缺陷 D4）。
 */
export function grammarMinutesOf(tasks: { module: string; plannedMinutes: number }[]): number {
  return tasks
    .filter((task) => task.module === 'GRAMMAR' || task.module === 'SENTENCE')
    .reduce((sum, task) => sum + Math.max(0, task.plannedMinutes), 0);
}

/** 当日语法上限分钟。 */
export function grammarCapMinutes(totalMinutes: number): number {
  return Math.floor(totalMinutes * GRAMMAR_CAP_RATIO);
}
