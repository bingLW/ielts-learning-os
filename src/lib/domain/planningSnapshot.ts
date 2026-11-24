/**
 * 计划输入快照的**规范化与哈希**（T02，H-1..H-5）。
 *
 * 存在的唯一理由：`PlanningSnapshot` 要能回答「上次为什么这么排」。
 * 要做到这一点，**同输入必须同 hash**（否则每次生成都新建一行快照，表按调用次数膨胀），
 * **规则一变必须换 hash**（否则改了权重却复用旧快照，等于拿旧解释说明新结果）。
 *
 * 五条规范化规则逐条对应一个真实故障：
 *
 * | 规则 | 不做会怎样 |
 * |---|---|
 * | H-1 键名字典序 + 数组按声明主键排序 | Prisma 返回顺序不稳定 → 同输入不同 hash |
 * | H-2 排除原始时间戳，只留派生整数 | `createdAt` 每次都不同 → hash 永不命中 |
 * | H-3 浮点 round(3) | `0.30000000000000004` ≠ `0.3` → 无意义的 hash 抖动 |
 * | H-4 `undefined → null`，但 `[] ≠ null` | 把「源挂了」和「源是空的」混成一种状态 |
 * | H-5 `RULE_VERSION` + `weightsVersion` + `config` 进 hash | 改规则/权重误复用旧快照 |
 *
 * 这一层是**纯函数**：不读库、不读时钟、不读环境。时间相关的量一律由调用方折算成
 * 派生整数（`freshnessDays` / `overdueDays` / `horizonDays`）再传进来。
 */

import { createHash } from 'node:crypto';
import { SKILL_IDS } from '../constants';
import { addDays } from '../date';
import type { SkillId } from '../types';

/**
 * 调度语义版本。
 *
 * **规则一改必须递增**：它进 hash，是"旧快照不再适用"的唯一开关。
 * 改判定顺序、改权重默认值、改严重度公式，都属于"改规则"。
 */
export const RULE_VERSION = 'v2.7.0';

/** 计划层级（与 `PlanVersion.layer` 的取值一致，null 语义在 `periodOf` 里处理）。 */
export const PLANNING_LAYERS = ['DAY', 'WEEK', 'MONTH', 'CYCLE'] as const;
export type PlanningLayer = (typeof PLANNING_LAYERS)[number];

/** 各层级覆盖的天数（含起始日）。 */
export const LAYER_SPAN_DAYS: Record<PlanningLayer, number> = {
  DAY: 0,
  WEEK: 6,
  MONTH: 29,
  CYCLE: 89,
};

/** hash 截断长度：32 位十六进制 = 128 bit，做幂等键足够，且比全长好读。 */
export const PLANNING_HASH_LENGTH = 32;

/**
 * 数组元素的**声明主键**（H-1）。
 *
 * 为什么不用 `JSON.stringify` 后整体排序：那样一旦某个字段变了，元素的相对顺序
 * 也会跟着跳，排序结果不稳定。按业务主键排，顺序只由主键决定。
 */
const ELEMENT_KEY_PRIORITY = [
  'candidateKey',
  'id',
  'key',
  'code',
  'date',
  'planDate',
] as const;

/** 复合主键：缺口维度（`dimensionKind|skill|subskill`）。 */
function compositeDimensionKey(row: Record<string, unknown>): string | null {
  const { dimensionKind, skill, subskill } = row;
  if (typeof skill !== 'string') return null;
  return `${typeof dimensionKind === 'string' ? dimensionKind : 'OFFICIAL'}|${skill}|${
    typeof subskill === 'string' ? subskill : ''
  }`;
}

/** 给数组元素找一个稳定排序键（找不到就退化成规范化后的 JSON 字符串）。 */
function stableElementKey(row: unknown): string {
  if (row === null || row === undefined) return '';
  if (typeof row !== 'object') return String(row);
  const record = row as Record<string, unknown>;
  for (const key of ELEMENT_KEY_PRIORITY) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  const dimension = compositeDimensionKey(record);
  if (dimension) return dimension;
  return JSON.stringify(row);
}

/**
 * 原始时间戳字段判据（H-2）。
 *
 * 只认「时刻」语义的字段：`createdAt` / `updatedAt` / `judgedAt` / `lastActiveAt`…
 * 它们每次读库都可能不同（`updatedAt` 尤其），进 hash 就等于把 hash 变成随机数。
 *
 * **不拦** `dueDate` / `planDate` / `startDate` 这类业务日期 —— 它们是输入本身，
 * 变了就应该换 hash。
 */
function isRawTimestampKey(key: string): boolean {
  if (key === 'timestamp' || key === 'instant' || key === 'now') return true;
  if (!/At$/.test(key)) return false;
  // 白名单例外：派生整数/日期字段不会以 At 结尾，这里只做防御性说明
  return key !== 'staleAt';
}

/** 浮点统一保留 3 位（H-3）。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 规范化任意结构（H-1 ~ H-4）。
 *
 * @param value 任意输入（对象 / 数组 / 标量）
 * @returns 纯 JSON 安全、键序确定、浮点收敛、`undefined` 已归一为 `null` 的结构
 */
export function canonicalizePlanningValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? round3(value) : null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // H-4：空数组保持 `[]`（与 null 是两件事：源可用但为空 vs 源不可用）
    const items = value.map((item) => canonicalizePlanningValue(item));
    return items
      .map((item) => ({ key: stableElementKey(item), value: item }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map((entry) => entry.value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // H-1：键名递归字典序
    for (const key of Object.keys(record).sort()) {
      // H-2：原始时间戳不进 hash
      if (isRawTimestampKey(key)) continue;
      out[key] = canonicalizePlanningValue(record[key]);
    }
    return out;
  }
  return null;
}

/** 进 hash 的最小结构（H-5 的两项在这里强制要求，不给默认值）。 */
export interface HashablePlanningInput extends Record<string, unknown> {
  /** 权重版本（`PlannerSettings.priorityPolicy.weightsVersion`）。 */
  weightsVersion: string;
  /** 配置快照（阈值、缓冲比例、派生分钟表…）。 */
  config: unknown;
}

/** 规范化结果：`canonical` 既是 hash 的输入，**也是落库的内容**。 */
export interface CanonicalPlanningResult {
  /** 归一化后的对象（已排序/已收敛浮点/已剔时间戳）。 */
  canonical: Record<string, unknown>;
  hash: string;
}

/**
 * 一次性产出「归一化对象 + hash」。
 *
 * **为什么返回 canonical 而不是只返回 hash**：如果只对 hash 归一化、落库仍写未归一的
 * 原值，就会「hash 相同、内容不同」—— 两次相差 0.0001 的运行会复用同一份旧快照，
 * 而旧快照里存的还是上一轮的值。调用方必须拿 `canonical` 里的各段去
 * `JSON.stringify` 落库，不要序列化原值再单独哈希。
 *
 * @param input 规范化之前的输入（内部会再规范化一次，调用方不必自己排序）
 * @throws 缺少 `weightsVersion` / `config` 时抛出（编程错误，不是数据错误）
 */
export function buildCanonicalPlanningInput(
  input: HashablePlanningInput,
): CanonicalPlanningResult {
  if (typeof input.weightsVersion !== 'string' || input.weightsVersion.length === 0) {
    throw new Error('hashPlanningInput 缺少 weightsVersion：权重变更必须换 hash（H-5）');
  }
  if (input.config === undefined) {
    throw new Error('hashPlanningInput 缺少 config：配置变更必须换 hash（H-5）');
  }

  const canonical = canonicalizePlanningValue({
    ...input,
    v: RULE_VERSION,
  }) as Record<string, unknown>;

  const hash = createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
    .slice(0, PLANNING_HASH_LENGTH);

  return { canonical, hash };
}

/**
 * 计划输入 hash（H-1 ~ H-5）。
 *
 * @param canonical 规范化之前的输入
 */
export function hashPlanningInput(canonical: HashablePlanningInput): string {
  return buildCanonicalPlanningInput(canonical).hash;
}

/** 层级区间的输入（只取需要的两个字段，便于从 `PlanVersion` 行直接传入）。 */
export interface LayerInput {
  layer?: string | null;
  planDate: string;
}

/** 层级区间（含首尾）。 */
export interface PlanPeriod {
  layer: PlanningLayer;
  start: string;
  end: string;
}

/**
 * 版本层级 → 覆盖区间（区间**不落列**，永远由这里派生）。
 *
 * `null` / `undefined` 读作 `DAY`：v2.7 之前的 `PlanVersion` 全是日计划，
 * 它们没有 layer 列值，但不代表"层级未知"。
 *
 * 未知字符串**抛错**而不是回落到 DAY：这是新列，出现别的值只可能是写坏了，
 * 静默当成日计划会让一个 30 天版本的区间悄悄缩成 1 天。
 *
 * @param input `{ layer, planDate }`
 */
export function periodOf(input: LayerInput): PlanPeriod {
  const raw = input.layer ?? 'DAY';
  if (!(PLANNING_LAYERS as readonly string[]).includes(raw)) {
    throw new Error(`未知的计划层级：${raw}（只允许 ${PLANNING_LAYERS.join('|')} 或 null）`);
  }
  const layer = raw as PlanningLayer;
  return {
    layer,
    start: input.planDate,
    end: addDays(input.planDate, LAYER_SPAN_DAYS[layer]),
  };
}

/**
 * 把自由 JSON 里的技能目标收窄成 `Partial<Record<SkillId, number>>`。
 *
 * 为什么不能直接用 `Record<string, number>`：那个类型会让 TS 告诉你**每个键都一定有
 * `number`** —— 而实际未列出的 `SkillId` 取到的是 `undefined`，它流进 `goalRelevance`
 * 的算术就变 `NaN`；`NaN` 参与比较恒 `false`，`sort` 不报错、只静默乱序。
 *
 * 所以这里做两件事：
 * 1. **丢掉非 `SkillId` 的键**（脏配置不该变成"某个技能有目标"）；
 * 2. 返回值类型是 `Partial<…>`，读取侧必须写 `?? 0.30`（该技能不在目标内）。
 *
 * ⚠️ **值必须是 `number`，不能用 `Number(value)` 收窄**：`LearningGoal` 的四个分数字段
 * 都是 `Float?`，`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`、
 * `Number(false) === 0` —— 用 `Number()` 收窄会把「**没设目标**」变成一个真实存在的
 * 「**目标 0 分**」。这两件事在读侧完全不同：前者走"该技能与目标无直接关系"的中性分，
 * 后者算出"已经完全达标"。后者更难发现，因为它在数值上看起来完全正常。
 *
 * ⚠️ **显式 `0` 必须保留**（`{READING: 0}` 与原样 0 都要留着）：`0` 是合法目标值，
 * "没设目标"的唯一判据是**键不存在**，这正是 `Partial` 要表达的东西。
 *
 * ⚠️ **与 `services/candidateSources.ts:sourceMinutesOf()` 对 `0` 的处理相反** ——
 * 那里把 `0` 当"缺数据"落兜底。两处不是笔误：目标是"想要多少分"，`0` 是有效输入；
 * 而 0 分钟的**任务**在装箱时"永远放得下"，会把真实任务挤出去且不留痕迹。
 * 见到这两处的差异时请先读这句，不要"统一一下"。
 *
 * @param raw 任意输入（通常来自 `LearningGoal` 的四个分数字段）
 */
export function parseSkillTargets(raw: unknown): Partial<Record<SkillId, number>> {
  const known = new Set<string>(SKILL_IDS);
  const out: Partial<Record<SkillId, number>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) continue;
    // 严格 `typeof`：null / '' / [] / false / '20' 全部丢弃（见上方注释）
    if (typeof value !== 'number') continue;
    if (!Number.isFinite(value) || value < 0) continue;
    out[key as SkillId] = value;
  }
  return out;
}
