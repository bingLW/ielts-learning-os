/**
 * 周复盘 13 项指标 —— 纯函数，零 IO。
 *
 * 设计要点：
 * 1. 指标清单**只有一份**：`constants.WEEKLY_METRIC_KEYS`。这里按它逐项产出，
 *    所以任何新增/调整顺序都只改常量，不会出现「页面少一项」的漂移。
 * 2. `auto` 是系统算出的值，`override` 是用户手改的值；两者都保留，
 *    UI 用 `effectiveValue` 展示、用 `overridden` 标记「已手工覆盖」。
 * 3. 无数据的指标一律返回 `—`（`EMPTY_PLACEHOLDER`），绝不用 0 冒充。
 */

import {
  SKILL_BUCKET_LABEL_ZH,
  SKILL_BUCKET_ORDER,
  WEEKLY_METRIC_KEYS,
  WEEKLY_METRIC_LABEL_ZH,
  WEEKLY_TOP3_COUNT,
} from '../constants';
import { addDays } from '../date';
import { EMPTY_PLACEHOLDER, formatDelta, formatDurationZh, formatPercent } from '../format';
import type {
  MasteryLevel,
  SkillBucket,
  WeaknessDto,
  WeeklyMetricKey,
  WeeklyMetricValueDto,
  WeeklyReviewDto,
  WeeklyTop3Dto,
} from '../types';

/** 一周 7 天（用于「每日时长分布」补齐空缺日）。 */
const DAYS_PER_WEEK = 7;

/** 单项指标的自动值。 */
export interface WeeklyMetricDraft {
  key: WeeklyMetricKey;
  autoValue: string;
}

/** 三色计数（当前周 / 上周）。 */
export interface ColorCounts {
  green: number;
  yellow: number;
  red: number;
  pending: number;
}

/**
 * 周复盘计算的原始输入。
 *
 * 所有分钟数都必须来自既有的净时长聚合（`StudySessionDaySplit` 求和），
 * 不允许在页面层用 `endedAt - startedAt` 自己算。
 */
export interface WeeklyRawInput {
  weekStart: string;
  weekEnd: string;
  /** 本周净学习时长（分钟）。 */
  netMinutes: number;
  /** 上周净学习时长（分钟）。 */
  prevNetMinutes: number;
  /** 本周逐日净时长（可缺日，函数内部补齐 7 天）。 */
  dailyMinutes: { date: string; minutes: number }[];
  /** 按计划分钟加权的完成率（0..1）；无计划任务 → null。 */
  completionByTime: number | null;
  /** 8 个桶的分钟数（泛听泛读只在 EXTENSIVE）。 */
  skillMinutes: Record<SkillBucket, number>;
  egiu: ColorCounts;
  prevEgiu: ColorCounts;
  review: {
    done: number;
    failed: number;
    overdue: number;
    /** 本周新判为掌握（含转低频池）的 EGIU 单元数。 */
    masteredLessons: number;
  };
  mistakes: {
    added: number;
    mastered: number;
    /** 本周出现次数最多的错误类别中文名；无错题 → null。 */
    topCategoryLabel: string | null;
  };
  vocab: {
    newCount: number;
    reviewCount: number;
    quizAccuracy: number | null;
  };
  mastery: Record<MasteryLevel, number>;
  /** 有数据的天数。 */
  dataDays: number;
  /** 本周已经过去的天数（1..7）。 */
  daysElapsed: number;
}

/** 带符号整数：`+3` / `-2` / `0`。 */
function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/** 「每日时长分布」：`03-04 2h 15m / 03-05 1h`，缺日显示 `0m`。 */
function dailyDistributionText(input: WeeklyRawInput): string {
  if (input.dailyMinutes.length === 0) return EMPTY_PLACEHOLDER;
  const byDate = new Map<string, number>();
  for (const row of input.dailyMinutes) {
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + Math.max(0, Math.round(row.minutes)));
  }
  const parts: string[] = [];
  for (let index = 0; index < DAYS_PER_WEEK; index += 1) {
    const date = addDays(input.weekStart, index);
    parts.push(`${date.slice(5)} ${formatDurationZh(byDate.get(date) ?? 0)}`);
  }
  return parts.join(' / ');
}

/** 「三色环比」：`绿 6(+2) / 黄 3(0) / 红 1(-1)`。 */
function colorDeltaText(current: ColorCounts, previous: ColorCounts): string {
  const total = current.green + current.yellow + current.red + current.pending;
  if (total === 0) return EMPTY_PLACEHOLDER;
  return [
    `绿 ${current.green}(${signed(current.green - previous.green)})`,
    `黄 ${current.yellow}(${signed(current.yellow - previous.yellow)})`,
    `红 ${current.red}(${signed(current.red - previous.red)})`,
    `待判定 ${current.pending}(${signed(current.pending - previous.pending)})`,
  ].join(' / ');
}

/** 单科投入文案：`2 小时 15 分`。 */
function bucketText(minutes: Record<SkillBucket, number>, bucket: SkillBucket): string {
  return formatDurationZh(minutes[bucket] ?? 0);
}

/** 按 13 项指标逐个计算自动值。 */
function computeMetric(key: WeeklyMetricKey, input: WeeklyRawInput): string {
  switch (key) {
    case 'NET_MINUTES': {
      if (input.dataDays === 0) return EMPTY_PLACEHOLDER;
      const average = Math.round(input.netMinutes / Math.max(1, input.dataDays));
      return `${formatDurationZh(input.netMinutes)}（日均 ${formatDurationZh(average)}）`;
    }
    case 'DAILY_DISTRIBUTION':
      return input.dataDays === 0 ? EMPTY_PLACEHOLDER : dailyDistributionText(input);
    case 'COMPLETION_RATE':
      return formatPercent(input.completionByTime);
    case 'LISTENING':
      return bucketText(input.skillMinutes, 'LISTENING');
    case 'READING':
      return bucketText(input.skillMinutes, 'READING');
    case 'SPEAKING':
      return bucketText(input.skillMinutes, 'SPEAKING');
    case 'WRITING':
      return bucketText(input.skillMinutes, 'WRITING');
    case 'GRAMMAR': {
      const minutes = bucketText(input.skillMinutes, 'GRAMMAR');
      if (input.review.masteredLessons <= 0) return minutes;
      return `${minutes}（本周新掌握 ${input.review.masteredLessons} 个单元）`;
    }
    case 'COLOR_DELTA':
      return colorDeltaText(input.egiu, input.prevEgiu);
    case 'MISTAKES': {
      const parts = [
        `新增 ${input.mistakes.added} 道`,
        `标记掌握 ${input.mistakes.mastered} 道`,
        `复测完成 ${input.review.done} 条（未通过 ${input.review.failed} 条）`,
      ];
      if (input.review.overdue > 0) parts.push(`逾期未做 ${input.review.overdue} 条`);
      return parts.join(' · ');
    }
    case 'VOCAB': {
      const accuracy =
        input.vocab.quizAccuracy === null ? EMPTY_PLACEHOLDER : formatPercent(input.vocab.quizAccuracy);
      return [
        `新词 ${input.vocab.newCount} 个`,
        `复习 ${input.vocab.reviewCount} 个`,
        `抽测加权正确率 ${accuracy}`,
        `三档：认识 ${input.mastery.RECOGNIZE_ONLY} / 理解 ${input.mastery.COMPREHEND} / 主动用 ${input.mastery.ACTIVE_USE}`,
      ].join(' · ');
    }
    case 'TOP_ERROR_CATEGORY':
      return input.mistakes.topCategoryLabel ?? '本期无错题记录';
    case 'WEEK_OVER_WEEK': {
      if (input.dataDays === 0) return EMPTY_PLACEHOLDER;
      const delta = input.netMinutes - input.prevNetMinutes;
      return `${formatDurationZh(input.netMinutes)}（上周 ${formatDurationZh(
        input.prevNetMinutes,
      )}，${formatDelta(delta, '分')}）`;
    }
    default:
      return EMPTY_PLACEHOLDER;
  }
}

/** 按 `WEEKLY_METRIC_KEYS` 的顺序产出 13 项自动值。 */
export function buildWeeklyMetrics(input: WeeklyRawInput): WeeklyMetricDraft[] {
  return WEEKLY_METRIC_KEYS.map((key) => ({ key, autoValue: computeMetric(key, input) }));
}

/** 库里存的单条指标形态（`WeeklyReview.metrics` JSON 的元素）。 */
export interface StoredMetricEntry {
  auto: string;
  override: string | null;
  overriddenAt: string | null;
}

/** `WeeklyReview.metrics` 反序列化后的形态。 */
export type StoredWeeklyMetrics = Partial<Record<WeeklyMetricKey, StoredMetricEntry>>;

/** 合并自动值 + 手工覆盖值 → 页面/导出用的 13 项。 */
export function mergeWeeklyMetrics(
  drafts: WeeklyMetricDraft[],
  stored: StoredWeeklyMetrics | null,
): WeeklyMetricValueDto[] {
  return drafts.map((draft) => {
    const entry = stored?.[draft.key];
    const overrideRaw = entry?.override ?? null;
    const override = overrideRaw && overrideRaw.trim().length > 0 ? overrideRaw.trim() : null;
    return {
      key: draft.key,
      label: WEEKLY_METRIC_LABEL_ZH[draft.key],
      autoValue: draft.autoValue,
      overrideValue: override,
      effectiveValue: override ?? draft.autoValue,
      overridden: override !== null,
    };
  });
}

/** 13 项 → 落库 JSON（保留 auto，便于回溯系统值）。 */
export function toStoredMetrics(
  metrics: WeeklyMetricValueDto[],
  nowIso: string,
): StoredWeeklyMetrics {
  const out: StoredWeeklyMetrics = {};
  for (const metric of metrics) {
    out[metric.key] = {
      auto: metric.autoValue,
      override: metric.overrideValue,
      overriddenAt: metric.overrideValue ? nowIso : null,
    };
  }
  return out;
}

/** 本周是否属于「不完整周」（周内当天或数据缺口）。 */
export function isPartialWeek(dataDays: number, daysElapsed: number): boolean {
  const elapsed = Math.min(DAYS_PER_WEEK, Math.max(1, Math.round(daysElapsed)));
  return elapsed < DAYS_PER_WEEK || dataDays < elapsed;
}

/** 把薄弱点榜单映射成 Top3 草稿。 */
export function pickTop3FromRanked(ranked: WeaknessDto[]): WeeklyTop3Dto[] {
  return ranked.slice(0, WEEKLY_TOP3_COUNT).map((item) => ({
    name: item.name,
    score: item.score,
    evidence: item.evidence,
    manual: false,
  }));
}

/** 空 Top3（手工填写模式）。 */
export function emptyTop3(): WeeklyTop3Dto[] {
  return Array.from({ length: WEEKLY_TOP3_COUNT }, () => ({
    name: '',
    score: 0,
    evidence: '',
    manual: true,
  }));
}

/** 规整 Top3：去掉空项、补齐到 3 项、score 夹在 0..1。 */
export function normalizeTop3(input: Partial<WeeklyTop3Dto>[]): WeeklyTop3Dto[] {
  const cleaned: WeeklyTop3Dto[] = [];
  for (const item of input) {
    const name = (item.name ?? '').trim();
    if (name.length === 0) continue;
    const score = Number(item.score ?? 0);
    cleaned.push({
      name,
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
      evidence: (item.evidence ?? '').trim(),
      manual: item.manual ?? true,
    });
  }
  return cleaned.slice(0, WEEKLY_TOP3_COUNT);
}

/** Top3 必填校验（PRD 硬要求：必须填满 3 项）。 */
export function validateTop3(
  top3: WeeklyTop3Dto[],
): { ok: true } | { ok: false; message: string } {
  const filled = normalizeTop3(top3);
  if (filled.length < WEEKLY_TOP3_COUNT) {
    return {
      ok: false,
      message: `下周 Top3 薄弱点必须填满 ${WEEKLY_TOP3_COUNT} 项（当前 ${filled.length} 项）`,
    };
  }
  return { ok: true };
}

/** 8 个桶的示意顺序标签（页面/图表复用）。 */
export function skillBucketLabels(): { bucket: SkillBucket; label: string }[] {
  return SKILL_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: SKILL_BUCKET_LABEL_ZH[bucket],
  }));
}

/** 周复盘纯文本导出（用于复制/打印，不依赖 CSV 通道）。 */
export function formatWeeklyExportText(dto: WeeklyReviewDto): string {
  const lines: string[] = [];
  lines.push(`周复盘 ${dto.isoYear}-W${String(dto.isoWeek).padStart(2, '0')}`);
  lines.push(`周期：${dto.weekStart} ~ ${dto.weekEnd}${dto.isPartial ? '（不完整周）' : ''}`);
  lines.push('');
  lines.push('一、指标');
  for (const metric of dto.metrics) {
    const tag = metric.overridden ? '（手工覆盖）' : '';
    lines.push(`- ${metric.label}：${metric.effectiveValue}${tag}`);
  }
  lines.push('');
  lines.push('二、下周 Top3 薄弱点');
  dto.top3.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.name}｜依据：${item.evidence || EMPTY_PLACEHOLDER}`);
  });
  if (dto.reviewNote && dto.reviewNote.trim().length > 0) {
    lines.push('');
    lines.push('三、备注');
    lines.push(dto.reviewNote.trim());
  }
  return lines.join('\n');
}
