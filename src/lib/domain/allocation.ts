/**
 * 四技能配比与占比 —— 纯函数。
 *
 * 这是 v2.0 最核心也最容易做错的一块，三条硬规则：
 *
 * 1. **分母只含四项技能专项训练时间**。
 *    词汇、语法、句子成分、复盘、泛听泛读、媒介学习的支持部分一律不进分母
 *    （SOP v2 §2：「词汇、语法、发音讲解、复盘和工具学习不进入该比例的分母」）。
 *
 * 2. **分母为 0 时占比是 `null`，不是 0**。
 *    补 0 会让「本周还没有任何技能训练」显示成「四项各 0%」，与「各 0%」在
 *    语义上完全不同。UI 统一展示 `—`。
 *
 * 3. **配比合计必须等于 100**，否则拒绝保存。
 *    这是需求 §11.1 的明确验收项：「自定义权重总和不等于 100% 时拒绝保存并给出提示」。
 *
 * 本模块不 import prisma，`today` 由调用方注入，可直接单测。
 */

import {
  ALLOCATION_MAX_PCT,
  ALLOCATION_MIN_MINUTES,
  ALLOCATION_MIN_PCT,
  ALLOCATION_SKILLS,
  ALLOCATION_SUM,
  STAGE_ALLOCATION,
} from '../constants';
import type {
  AllocationCheck,
  AllocationSkill,
  PrimarySkill,
  SkillAllocation,
  SkillShareDto,
  StageProfileCode,
} from '../types';

// ───────────────────────── 配比校验 ─────────────────────────

/** 四项之和。 */
export function allocationTotal(allocation: SkillAllocation): number {
  return (
    allocation.LISTENING + allocation.READING + allocation.SPEAKING + allocation.WRITING
  );
}

/**
 * 校验并归一化配比。
 *
 * 校验顺序（不可调换，否则错误码会指错方向）：
 * ① 非有限数 / 负数 → `NEGATIVE_OR_NAN`
 * ② 单项越界（<5 或 >60）→ `SUM_NOT_100`? 否 —— 单独一个 `OUT_OF_RANGE` 语义更准，
 *    但为了不扩大错误码集合，这里并入 `SUM_NOT_100` 并给出明确文案。
 * ③ 合计 ≠ 100 → `SUM_NOT_100`
 *
 * @returns 成功时返回**取整后**的配比（四项为整数百分比）
 */
export function checkAllocation(input: Partial<Record<AllocationSkill, number>>): AllocationCheck {
  const raw: Record<AllocationSkill, number> = {
    LISTENING: input.LISTENING ?? 0,
    READING: input.READING ?? 0,
    SPEAKING: input.SPEAKING ?? 0,
    WRITING: input.WRITING ?? 0,
  };

  for (const skill of ALLOCATION_SKILLS) {
    const value = raw[skill];
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, code: 'NEGATIVE_OR_NAN', error: `「${skill}」的配比必须是非负数字` };
    }
  }

  const rounded: SkillAllocation = {
    LISTENING: Math.round(raw.LISTENING),
    READING: Math.round(raw.READING),
    SPEAKING: Math.round(raw.SPEAKING),
    WRITING: Math.round(raw.WRITING),
  };

  for (const skill of ALLOCATION_SKILLS) {
    const value = rounded[skill];
    if (value < ALLOCATION_MIN_PCT || value > ALLOCATION_MAX_PCT) {
      return {
        ok: false,
        code: 'SUM_NOT_100',
        total: allocationTotal(rounded),
        error: `「${skill}」的配比必须在 ${ALLOCATION_MIN_PCT}–${ALLOCATION_MAX_PCT} 之间（当前 ${value}）`,
      };
    }
  }

  const total = allocationTotal(rounded);
  if (total !== ALLOCATION_SUM) {
    return {
      ok: false,
      code: 'SUM_NOT_100',
      total,
      error: `四项技能配比合计必须为 ${ALLOCATION_SUM}%，当前为 ${total}%（差 ${ALLOCATION_SUM - total}）`,
    };
  }

  return { ok: true, allocation: rounded, total: 100 };
}

/** 阶段内置配比（深拷贝，避免调用方改到常量）。 */
export function defaultAllocationFor(profileCode: StageProfileCode): SkillAllocation {
  return { ...STAGE_ALLOCATION[profileCode] };
}

// ───────────────────────── 实际占比 ─────────────────────────

/** 技能分钟输入（只认 `PrimarySkill`）。 */
export interface PrimarySkillMinutes {
  LISTENING: number;
  READING: number;
  SPEAKING: number;
  WRITING: number;
  FOUNDATION: number;
}

/** 空输入。 */
export function emptyPrimaryMinutes(): PrimarySkillMinutes {
  return { LISTENING: 0, READING: 0, SPEAKING: 0, WRITING: 0, FOUNDATION: 0 };
}

/** 把一组「技能 + 分钟」累加进桶。负数分钟按 0 处理（脏数据防御）。 */
export function accumulatePrimaryMinutes(
  rows: { skill: PrimarySkill | string; minutes: number }[],
): PrimarySkillMinutes {
  const out = emptyPrimaryMinutes();
  for (const row of rows) {
    const minutes = Math.max(0, Math.round(row.minutes));
    if (!Number.isFinite(minutes)) continue;
    switch (row.skill) {
      case 'LISTENING':
        out.LISTENING += minutes;
        break;
      case 'READING':
        out.READING += minutes;
        break;
      case 'SPEAKING':
        out.SPEAKING += minutes;
        break;
      case 'WRITING':
        out.WRITING += minutes;
        break;
      case 'FOUNDATION':
        out.FOUNDATION += minutes;
        break;
      default:
        // 未知技能（含脏数据）按支持性时间记，绝不塞进四技能分母
        out.FOUNDATION += minutes;
        break;
    }
  }
  return out;
}

/**
 * 计算四技能实际占比。
 *
 * 分母 = L + R + S + W。分母为 0 → `share` 全为 `null`（UI 展示 `—`）。
 * `foundationMinutes` 单列返回，供页面提示「支持性时间未计入分母」。
 */
export function skillShare(minutes: PrimarySkillMinutes): SkillShareDto {
  const four: SkillAllocation = {
    LISTENING: Math.max(0, minutes.LISTENING),
    READING: Math.max(0, minutes.READING),
    SPEAKING: Math.max(0, minutes.SPEAKING),
    WRITING: Math.max(0, minutes.WRITING),
  };
  const denominator =
    four.LISTENING + four.READING + four.SPEAKING + four.WRITING;

  const share: SkillShareDto['share'] = {
    LISTENING: null,
    READING: null,
    SPEAKING: null,
    WRITING: null,
  };

  if (denominator > 0) {
    for (const skill of ALLOCATION_SKILLS) {
      share[skill] = four[skill] / denominator;
    }
  }

  return {
    minutes: four,
    denominator,
    share,
    foundationMinutes: Math.max(0, minutes.FOUNDATION),
  };
}

/**
 * 配比偏离度（实际占比 − 建议占比，单位：百分点）。
 *
 * 分母为 0 时返回 `null`（不是「全部 −建议值」—— 那会显示成四项都欠训练，
 * 而实际是本周还没开始）。
 */
export function allocationDeviation(
  minutes: PrimarySkillMinutes,
  target: SkillAllocation,
): Record<AllocationSkill, number> | null {
  const { denominator, share } = skillShare(minutes);
  if (denominator === 0) return null;

  const out = {} as Record<AllocationSkill, number>;
  for (const skill of ALLOCATION_SKILLS) {
    const actual = share[skill];
    if (actual === null) return null;
    out[skill] = Math.round((actual - target[skill] / ALLOCATION_SUM) * 1000) / 10;
  }
  return out;
}

/**
 * 按配比把「四项技能总分钟」拆成各项计划分钟。
 *
 * 用最大余数法保证 **Σ 结果 === totalMinutes**（避免四舍五入导致少 1 分钟）。
 * `totalMinutes <= 0` 时全 0。
 */
export function splitByAllocation(
  totalMinutes: number,
  allocation: SkillAllocation,
): Record<AllocationSkill, number> {
  const total = Math.max(0, Math.round(totalMinutes));
  const out: Record<AllocationSkill, number> = {
    LISTENING: 0,
    READING: 0,
    SPEAKING: 0,
    WRITING: 0,
  };
  if (total === 0) return out;

  const sum = allocationTotal(allocation);
  if (sum <= 0) return out;

  // ① 先取整数部分
  const remainders: { skill: AllocationSkill; rest: number }[] = [];
  let assigned = 0;
  for (const skill of ALLOCATION_SKILLS) {
    const exact = (total * allocation[skill]) / sum;
    const floor = Math.floor(exact);
    out[skill] = floor;
    assigned += floor;
    remainders.push({ skill, rest: exact - floor });
  }

  // ② 余数从大到小补，平局按 ALLOCATION_SKILLS 顺序（保证结果确定）
  let leftover = total - assigned;
  remainders.sort((a, b) => {
    if (b.rest !== a.rest) return b.rest - a.rest;
    return ALLOCATION_SKILLS.indexOf(a.skill) - ALLOCATION_SKILLS.indexOf(b.skill);
  });
  for (const item of remainders) {
    if (leftover <= 0) break;
    out[item.skill] += 1;
    leftover -= 1;
  }

  return out;
}

/**
 * 判断某项技能是否需要「提升权重建议」（SOP v2 §5.2 / §9.1）。
 *
 * 规则：**连续两次**有效评估显示明显低于目标，才建议 +5~10 个百分点。
 * 单次不达标不改配比 —— 避免一周波动就重排整个计划。
 *
 * @param history 从旧到新排列的该技能占比（0..1）；不足 2 条返回 false
 * @param targetShare 目标占比（0..1）
 * @param tolerance 允许的偏离（默认 0.05 = 5 个百分点）
 */
export function shouldRaiseAllocation(
  history: (number | null)[],
  targetShare: number,
  tolerance = 0.05,
): boolean {
  const valid = history.filter((value): value is number => value !== null && Number.isFinite(value));
  if (valid.length < 2) return false;
  const lastTwo = valid.slice(-2);
  return lastTwo.every((actual) => actual < targetShare - tolerance);
}

/** 建议的提升幅度（百分点），限制在 5–10 之间（SOP v2 §5.2）。 */
export const ALLOCATION_RAISE_MIN = 5;
export const ALLOCATION_RAISE_MAX = 10;

/**
 * 生成「提升某技能」的建议配比，并从占比最高的技能里扣减。
 *
 * 返回 `null` 表示无法在不违反上下限的前提下调整。
 */
export function suggestRaise(
  allocation: SkillAllocation,
  skill: AllocationSkill,
  delta = ALLOCATION_RAISE_MIN,
): SkillAllocation | null {
  const step = Math.min(ALLOCATION_RAISE_MAX, Math.max(ALLOCATION_RAISE_MIN, Math.round(delta)));
  const next: SkillAllocation = { ...allocation };
  if (next[skill] + step > ALLOCATION_MAX_PCT) return null;

  // 从当前占比最高的**其他**技能里扣
  const donors = ALLOCATION_SKILLS.filter((s) => s !== skill).sort((a, b) => next[b] - next[a]);
  let need = step;
  for (const donor of donors) {
    if (need <= 0) break;
    const room = Math.max(0, next[donor] - ALLOCATION_MIN_PCT);
    const take = Math.min(room, need);
    next[donor] -= take;
    need -= take;
  }
  if (need > 0) return null;

  next[skill] += step;
  return checkAllocation(next).ok ? next : null;
}

// ───────────────────────── 每日四技能配平 ─────────────────────────

/**
 * 四技能模块的**基础分钟下限**与**总可调预算**。
 *
 * 为什么不能直接按配比切分：9 模块 240min 是 v1 冻结的容量契约
 * （`domain/plan.ts` 的增量分配、单科上限、20% 语法封顶都建在这个数上）。
 * 若直接把「四项之和」按百分比重算，会连带改变支持性模块的分钟数，
 * 从而破坏 `Σminutes === dailyMinutes` 与语法封顶这两条硬不变量。
 *
 * 正确做法：**四技能总分钟不变，只调整四者之间的分配**。
 * 这样配比能落地，其他不变量全部保持。
 */
export interface RebalanceResult {
  /** 调整后的四技能分钟（Σ 与输入完全相同）。 */
  minutes: Record<AllocationSkill, number>;
  /** 实际达成的占比（0..1）。 */
  achieved: Record<AllocationSkill, number>;
  /** 因整数取整无法精确达成的最大偏差（百分点，≤ 1/denominator）。 */
  maxDeviationPct: number;
}

/**
 * 在**保持四技能总分钟不变**的前提下，把四者调整到最接近目标配比的整数分配。
 *
 * 核心难点：配比是百分比，分钟是整数，必然取整。用最大余数法分配，
 * 但必须先满足每个技能的**可实施下限**（不能让某项降到 1 分钟这种不可执行的值）。
 *
 * @param current 当前四技能分钟（来自基础计划）
 * @param target 目标配比（四项之和须为 100）
 * @param minMinutes 单项可实施下限（默认取 `ALLOCATION_MIN_MINUTES`）
 * @returns 调整结果；`total === 0` 或配比非法时原样返回
 */
export function rebalanceFourSkills(
  current: Record<AllocationSkill, number>,
  target: SkillAllocation,
  minMinutes: number = ALLOCATION_MIN_MINUTES,
): RebalanceResult {
  const total = ALLOCATION_SKILLS.reduce((sum, skill) => sum + Math.max(0, current[skill]), 0);

  const achievedShare = (minutes: Record<AllocationSkill, number>, denom: number) => {
    const out = {} as Record<AllocationSkill, number>;
    for (const skill of ALLOCATION_SKILLS) {
      out[skill] = denom > 0 ? minutes[skill] / denom : 0;
    }
    return out;
  };

  // 总量为 0 或目标非法：原样返回，绝不凭空造分钟
  if (total <= 0 || allocationTotal(target) <= 0) {
    return {
      minutes: { ...current },
      achieved: achievedShare(current, total),
      maxDeviationPct: 0,
    };
  }

  // ① 理论值 + 整数下限保护：先给每项 `min(minMinutes, 理论值)`，
  //    剩余分钟再按最大余数法补。这样「写作 15%」在 240min 的四项预算里
  //    也不会被压到 0（0 分钟意味着任务直接消失）。
  const floor = Math.max(0, Math.min(Math.floor(minMinutes), Math.floor(total / 4)));
  const ideas: { skill: AllocationSkill; exact: number; base: number; rest: number }[] = [];
  let assigned = 0;

  for (const skill of ALLOCATION_SKILLS) {
    const exact = (total * target[skill]) / ALLOCATION_SUM;
    // 下限只抬不压：如果配比本来就给得比下限多，按下限给
    const base = Math.min(Math.max(Math.floor(exact), floor), Math.floor(exact) + 1);
    ideas.push({ skill, exact, base, rest: exact - base });
    assigned += base;
  }

  const minutes = {} as Record<AllocationSkill, number>;
  for (const idea of ideas) minutes[idea.skill] = idea.base;

  // ② 差额用最大余数法补/削，保证 Σ 严格等于 total
  let leftover = total - assigned;
  if (leftover > 0) {
    const order = [...ideas].sort((a, b) => {
      if (b.rest !== a.rest) return b.rest - a.rest;
      return ALLOCATION_SKILLS.indexOf(a.skill) - ALLOCATION_SKILLS.indexOf(b.skill);
    });
    let index = 0;
    while (leftover > 0 && order.length > 0) {
      minutes[order[index % order.length].skill] += 1;
      leftover -= 1;
      index += 1;
    }
  } else if (leftover < 0) {
    // 下限保护给了超过总量的分钟：从「离目标最远且高于下限」的技能里削回
    let guard = 0;
    while (leftover < 0 && guard < 1000) {
      guard += 1;
      const candidates = [...ideas]
        .filter((idea) => minutes[idea.skill] > Math.min(floor, minutes[idea.skill]))
        .sort((a, b) => a.rest - b.rest);
      const victim = candidates[0];
      if (!victim) break;
      minutes[victim.skill] -= 1;
      leftover += 1;
    }
  }

  const achieved = achievedShare(minutes, total);
  let maxDeviationPct = 0;
  for (const skill of ALLOCATION_SKILLS) {
    const deviation = Math.abs(achieved[skill] - target[skill] / ALLOCATION_SUM) * 100;
    if (deviation > maxDeviationPct) maxDeviationPct = deviation;
  }

  return { minutes, achieved, maxDeviationPct };
}

/**
 * 判断配比是否已经「足够接近」目标。
 *
 * 整数分钟不可能精确等于百分比，必须允许取整误差。
 * 容差取 `1 分钟 / 四项总分钟` 对应的百分点，再放宽到至少 1 个百分点。
 */
export function isAllocationClose(
  achieved: Record<AllocationSkill, number>,
  target: SkillAllocation,
  totalMinutes: number,
): boolean {
  if (totalMinutes <= 0) return true;
  const tolerance = Math.max(0.01, 1 / totalMinutes) * ALLOCATION_SUM;
  for (const skill of ALLOCATION_SKILLS) {
    const delta = Math.abs(achieved[skill] * ALLOCATION_SUM - target[skill]);
    if (delta > tolerance) return false;
  }
  return true;
}
