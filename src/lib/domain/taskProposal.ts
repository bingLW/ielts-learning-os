/**
 * 任务草案的**预算拆分**（T13 §2，F-02）。
 *
 * 这是纯函数模块：不碰 Prisma、不读时钟、不看环境。所有"能排多少"的输入
 * （材料包内容、每日预算）都由调用方算好传进来。这样做的理由是这一层最容易
 * 出**算错但不报错**的问题（多排 5 分钟、把休息日填满、把 90 分钟硬塞进 60 分钟），
 * 而纯函数可以用几十条用例把每条规则钉死。
 *
 * 产品语义（顺序不可调，顺序本身就是规则）：
 * 1. 粒度对齐：每条建议时长按 `granularity` **向上取整**（15/30/60），
 *    取整后为 0 的抬到粒度最小值 —— 草案里不出现 7 分钟这种排不进去的碎片；
 * 2. **休息日不排**：`isRestDay` 或 `minutes <= 0` 的日子直接跳过。
 *    不要"反正空着不用"地填进去 —— 休息日是用户明确声明的不可用时间；
 * 3. 顺序贪心装箱：装得下就整条放，装不下就填满当日剩余（剩余 < 粒度就不填），
 *    余量顺延到下一天；
 * 4. 单项大于任何单日预算 → 在同一条目内部**切成多段**（同标题/同模块），
 *    任何一天都不得超预算。宁可跨天，也不把 90 分钟硬塞进 60 分钟的日子；
 * 5. 给定天数用尽仍有剩余 → 继续往后排，基准取**最后一个非休息日的预算**，
 *    超出天数记进 `overflowDays`，并写进 `rationale`；
 * 6. 空输入 → 空结果，不抛错；
 * 7. 确定性：同一输入两次调用输出逐字相同（不允许 `Date.now()` / 随机 / Set 迭代序）。
 */

/** 拆分粒度的合法取值（分钟）。 */
export const PROPOSAL_GRANULARITIES = [15, 30, 60] as const;
export type ProposalGranularity = (typeof PROPOSAL_GRANULARITIES)[number];

/** 一条待排入草案的内容（材料包聚合后的产物）。 */
export interface ProposalSeed {
  /** `PlanTask.module` 的取值（VOCAB_REVIEW|READING|…）。 */
  module: string;
  /** 四技能子集（READING|WRITING|LISTENING|SPEAKING）。 */
  targetSkill: string;
  title: string;
  suggestedMinutes: number;
  /** 该条目依赖的练习题 id（可空）。 */
  exerciseIds?: string[];
  /** 为什么排这条（人话，直接展示）。 */
  reason?: string;
}

/** 一天的可用预算（`getEffectiveBudget` 的投影）。 */
export interface BudgetDay {
  /** `YYYY-MM-DD`。 */
  date: string;
  minutes: number;
  isRestDay: boolean;
}

export interface SplitOptions {
  /** 粒度（分钟）。 */
  granularity: ProposalGranularity;
  /**
   * 最多考虑 `days` 里的几个可用日（**不含**兜底顺延出来的天）。
   *
   * 用途：`baseDate` 给 7 天窗口，但用户只想先排前 3 天。
   * 超出的内容不会被丢弃 —— 按规则 5 顺延到窗口之后。
   */
  maxDays?: number;
}

/** 拆出来的一段（落在某一天）。 */
export interface SplitItem extends ProposalSeed {
  /** 落到哪一天（`YYYY-MM-DD`）。 */
  date: string;
  /** 这一段占多少分钟。 */
  minutes: number;
  /** 生成它时用的粒度（写进 `TaskProposalItem.granularity`）。 */
  granularity: number;
  /**
   * 分段说明（整条只有一段时为 `null`）。
   *
   * 为什么单独一个字段而不是拼进 `reason`：`reason` 是"为什么排这条"的
   * 业务理由，把它和"这是第 2 段"混在一起，前端就没法只改一处措辞。
   */
  segmentLabel: string | null;
}

export interface SplitResult {
  items: SplitItem[];
  totalMinutes: number;
  /** 用尽给定天数后仍需要额外的天数（0 = 完全落在给定窗口内）。 */
  overflowDays: number;
  /** 人话拆分理由（必须含每日分配摘要）。 */
  rationale: string;
}

/** 预算超支的一条明细。 */
export interface BudgetViolation {
  date: string;
  budgetMinutes: number;
  allocatedMinutes: number;
}

/** 把分钟数按粒度向上取整；结果至少为粒度本身。 */
function roundUpToGranularity(minutes: number, granularity: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return granularity;
  const rounded = Math.ceil(minutes / granularity) * granularity;
  return rounded <= 0 ? granularity : rounded;
}

/** 日期加天数（纯字符串运算，与 `lib/date` 的口径一致；这里不 import 以免 domain 依赖 lib）。 */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if ([year, month, day].some((part) => !Number.isFinite(part))) return date;
  const stamp = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const shifted = new Date(stamp);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 生成「每日分配摘要」：`10-24（45 分钟）/10-25（50 分钟）`。 */
function summarizeDays(dates: readonly string[], allocated: ReadonlyMap<string, number>): string {
  return dates
    .map((date) => `${date}（${allocated.get(date) ?? 0} 分钟）`)
    .join('/');
}

/** 唯一的空结果（避免各处手写不同措辞）。 */
function emptyResult(rationale: string): SplitResult {
  return { items: [], totalMinutes: 0, overflowDays: 0, rationale };
}

/**
 * 把材料包内容按每日预算拆到具体日期。
 *
 * @param seeds 待排入内容（顺序即优先级：先排前面的）
 * @param days 可用日期与预算（顺序即日期先后）
 * @param opts 粒度与天数上限
 */
export function splitProposalAcrossDays(
  seeds: readonly ProposalSeed[],
  days: readonly BudgetDay[],
  opts: SplitOptions,
): SplitResult {
  const granularity = Math.max(1, Math.floor(opts.granularity));

  if (seeds.length === 0) return emptyResult('没有可排入的内容');

  // ── 规则 1：粒度对齐（保留 seed 的其它字段） ──
  const prepared = seeds.map((seed) => ({
    seed,
    minutes: roundUpToGranularity(seed.suggestedMinutes, granularity),
  }));

  // ── 规则 2：跳过休息日与 0 预算日 ──
  const usableGiven = days.filter((day) => !day.isRestDay && day.minutes > 0);
  const restDays = days.length - usableGiven.length;
  const capped =
    opts.maxDays !== undefined && opts.maxDays > 0
      ? usableGiven.slice(0, Math.floor(opts.maxDays))
      : usableGiven;

  // 一天都排不了：不静默丢内容，明确说出来
  if (capped.length === 0) {
    return emptyResult('已设定的日期里没有可用预算（全是休息日或 0 分钟），无法排入内容');
  }

  // ── 规则 5 的基准：最后一个非休息日的预算 ──
  const baselineMinutes = usableGiven[usableGiven.length - 1].minutes;
  const lastGivenDate = capped[capped.length - 1].date;

  const items: SplitItem[] = [];
  const allocatedByDate = new Map<string, number>();
  const splitTitles = new Set<string>();

  let dayIndex = 0;
  let currentDate = capped[0].date;
  let remainingInDay = capped[0].minutes;
  /** 顺延出来的日历天偏移（含被跳过的休息日）。 */
  let overflowCursor = 0;
  /** 真正**落了内容**的顺延天数（`overflowDays` 的口径：需要多排几天）。 */
  let overflowDays = 0;
  /** 排不进去的分钟数（只在"兜底预算小于最小粒度"这种退化场景下非 0）。 */
  let unplacedMinutes = 0;

  /** 窗口外的某一天是否已被用户声明为休息日（0 预算或 isRestDay）。 */
  const isKnownRestDate = (date: string): boolean => {
    const row = days.find((item) => item.date === date);
    return row !== undefined && (row.isRestDay || row.minutes <= 0);
  };

  /**
   * 换到下一天：给定窗口内就前移；用尽之后按基准预算造新的一天。
   *
   * 窗口外**沿用窗口内的休息日声明**：10-25 被标成休息日，就不能因为"窗外"了
   * 又把任务排回 10-25。休息日是用户对**那一天**的声明，与窗口边界无关。
   */
  const advanceDay = (): void => {
    dayIndex += 1;
    if (dayIndex < capped.length) {
      currentDate = capped[dayIndex].date;
      remainingInDay = capped[dayIndex].minutes;
      return;
    }
    // 最多向后找 60 天，防脏数据导致死循环（60 天足够任何合理的材料包）
    for (let guard = 0; guard < 60; guard += 1) {
      overflowCursor += 1;
      const candidate = shiftDate(lastGivenDate, overflowCursor);
      if (isKnownRestDate(candidate)) continue;
      overflowDays += 1;
      currentDate = candidate;
      remainingInDay = baselineMinutes;
      return;
    }
    // 连找 60 天都不行：当作没有容量（`baselineMinutes` 太小，由外层保护收尾）
    currentDate = shiftDate(lastGivenDate, overflowCursor);
    remainingInDay = 0;
  };

  for (let seedIndex = 0; seedIndex < prepared.length; seedIndex += 1) {
    const { seed } = prepared[seedIndex];
    let remaining = prepared[seedIndex].minutes;

    // 先算出这条内容被切成几段（段标签要写"第 i/n 段"，n 必须先知道）
    const segments: Array<{ date: string; minutes: number }> = [];

    while (remaining > 0) {
      // 退化保护：兜底出来的天连一个粒度都放不下 → 停止，别死循环
      if (overflowCursor > 0 && baselineMinutes < granularity) {
        unplacedMinutes += remaining;
        remaining = 0;
        break;
      }

      // 当日剩余不够一个粒度：这一天到此为止（规则 3 的后半句）
      if (remainingInDay < granularity) {
        advanceDay();
        continue;
      }

      const fitsWhole = remaining <= remainingInDay;
      // 装不下就填满当日剩余，但**向下**对齐粒度，避免切出 7 分钟这种碎片
      const capacity = fitsWhole
        ? remaining
        : Math.floor(remainingInDay / granularity) * granularity;
      if (capacity < granularity) {
        advanceDay();
        continue;
      }

      const minutes = Math.min(remaining, capacity);
      segments.push({ date: currentDate, minutes });
      allocatedByDate.set(currentDate, (allocatedByDate.get(currentDate) ?? 0) + minutes);
      remainingInDay -= minutes;
      remaining -= minutes;
    }

    if (segments.length === 0) continue;
    const isSplit = segments.length > 1;
    if (isSplit) splitTitles.add(seed.title);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      items.push({
        ...seed,
        date: segment.date,
        minutes: segment.minutes,
        granularity,
        segmentLabel: isSplit ? `拆分第 ${index + 1}/${segments.length} 段` : null,
      });
    }
  }

  const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
  const usedDates: string[] = [];
  for (const item of items) {
    if (!usedDates.includes(item.date)) usedDates.push(item.date);
  }

  // ── rationale：必须能解释"为什么这样拆" ──
  const parts: string[] = [
    `共 ${totalMinutes} 分钟，按每日可用预算分配到 ${summarizeDays(usedDates, allocatedByDate)}`
    + `共 ${usedDates.length} 天`,
  ];
  if (restDays > 0) {
    parts.push(`已跳过 ${restDays} 个休息日（休息日不排任务）`);
  }
  const splitList = Array.from(splitTitles)
    .map((title) => `「${title}」`)
    .join('');
  if (splitList.length > 0) {
    parts.push(`${splitList}因单日预算不足被拆成多段`);
  }
  if (overflowDays > 0) {
    parts.push(`总时长超出已设定预算范围 ${overflowDays} 天（按最后一个非休息日的预算顺延）`);
  }
  if (unplacedMinutes > 0) {
    parts.push(
      `还有 ${unplacedMinutes} 分钟无法排入（顺延基准预算小于最小粒度 ${granularity} 分钟）`,
    );
  }

  return {
    items,
    totalMinutes,
    overflowDays,
    rationale: parts.join('；'),
  };
}

/**
 * 草案是否超预算（F-03 确认前的最后一道闸）。
 *
 * 判据：同一天所有条目的分钟数之和不得超过该日预算。
 * 休息日的预算视为 0 —— 排上去就是超支，不算"没有预算信息所以放行"。
 * `days` 里查不到的日期（规则 5 顺延出来的天）不做判定：那是草案自己造的天，
 * 真正的预算约束在用户确认时由计划层再校验一次。
 *
 * @param items 草案条目（`finalDate`/`finalMinutes` 已由调用方合并好）
 * @param days 基准日的预算快照
 */
export function validateProposalAgainstBudget(
  items: readonly { date: string; minutes: number }[],
  days: readonly BudgetDay[],
): { ok: boolean; violations: BudgetViolation[] } {
  const budgetByDate = new Map<string, number>();
  for (const day of days) {
    budgetByDate.set(day.date, day.isRestDay ? 0 : Math.max(0, day.minutes));
  }

  const allocated = new Map<string, number>();
  for (const item of items) {
    const minutes = Number.isFinite(item.minutes) ? item.minutes : 0;
    allocated.set(item.date, (allocated.get(item.date) ?? 0) + Math.max(0, minutes));
  }

  const violations: BudgetViolation[] = [];
  for (const [date, minutes] of allocated) {
    const budget = budgetByDate.get(date);
    if (budget === undefined) continue;
    if (minutes > budget) {
      violations.push({ date, budgetMinutes: budget, allocatedMinutes: minutes });
    }
  }

  violations.sort((left, right) => left.date.localeCompare(right.date));
  return { ok: violations.length === 0, violations };
}

/**
 * 把违反预算的结果压成一句人话（页面横幅与 `PRECONDITION` 的错误文案共用）。
 *
 * @param violations 逐日明细
 */
export function describeBudgetViolations(violations: readonly BudgetViolation[]): string {
  if (violations.length === 0) return '草案未超预算';
  const detail = violations
    .map(
      (row) =>
        `${row.date} 预算 ${row.budgetMinutes} 分钟，草案排了 ${row.allocatedMinutes} 分钟`,
    )
    .join('；');
  return `草案超出每日预算：${detail}`;
}
