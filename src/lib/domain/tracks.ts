/**
 * 三轨道统计与阶段 gate —— 纯函数。
 *
 * 这是 v2.0「三种目标分别统计和验收」的判定核心。四条硬规则：
 *
 * 1. **一条时长只能计一次**。轨道与技能都是同一条 `StudySession` 的属性，
 *    所以「轨道合计」「技能合计」「总净时长」三者天然自洽，不需要去重逻辑。
 *    反过来说：任何需要「减去某轨道时长」的实现都说明建模错了。
 *
 * 2. **CEFR、IELTS、媒介学习三者不互相换算**。本模块的 gate 函数各自只读
 *    自己的数据源，没有任何「IELTS 分数 → CEFR 等级」的映射表。
 *    这是刻意的：需求明确禁止二者机械等同。
 *
 * 3. **学习时长不参与能力判定**。`evaluateGeneralEnglishGate` 只看评估证据，
 *    `minutes` 字段仅用于展示，不进任何判定分支（需求 §11.1：
 *    「学习时间多但没有评估证据时，不自动将用户判为 B1/B2」）。
 *
 * 4. **gate 只给建议**，最终升级必须用户确认（写 `StageTransitionLog`）。
 */

import {
  CEFR_RANK,
  FLOAT_EPSILON,
  GE_GATE_MIN_ASSESSMENTS_PER_SKILL,
  IELTS_GATE_MAX_RECORDS,
  IELTS_GATE_MIN_RECORDS,
  MEDIATED_EVIDENCE_OUTPUTS,
  MEDIATED_GATE_MIN_SESSIONS_SYSTEMATIC,
  MEDIATED_GATE_MIN_SESSIONS_TRIAL,
  MEDIATED_INDEPENDENCE_PASS,
  MEDIATED_UNDERSTANDING_PASS,
  TRANSLATION_INDEPENDENCE_SCORE,
  UNDERSTANDING_SCORE,
} from '../constants';
import type {
  AllocationSkill,
  CefrLevel,
  LearningTrack,
  MediatedIntensity,
  MediatedUnderstanding,
  TrackStatDto,
  TranslationDependency,
} from '../types';

const ALLOCATION_SKILLS: AllocationSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];

const TRACK_LABEL: Record<LearningTrack, string> = {
  GENERAL_ENGLISH: 'General English',
  IELTS_PREPARATION: 'IELTS Preparation',
  ENGLISH_MEDIATED_LEARNING: 'English-mediated Learning',
};

// ───────────────────────── 轨道统计 ─────────────────────────

/** 一条带轨道与分钟数的记录（来自 DaySplit join Session）。 */
export interface TrackMinuteRow {
  track: LearningTrack | string;
  minutes: number;
}

/**
 * 按轨道汇总净分钟。
 *
 * **每条记录只落一个轨道**，所以这里就是简单的分组求和 —— 不存在重复计时的可能。
 * 未知轨道归入 `GENERAL_ENGLISH`（历史数据默认值），并在返回值里标注。
 */
export function trackStats(rows: TrackMinuteRow[]): {
  stats: TrackStatDto[];
  totalMinutes: number;
  unknownTrackMinutes: number;
} {
  const buckets: Record<LearningTrack, { minutes: number; sessionCount: number }> = {
    GENERAL_ENGLISH: { minutes: 0, sessionCount: 0 },
    IELTS_PREPARATION: { minutes: 0, sessionCount: 0 },
    ENGLISH_MEDIATED_LEARNING: { minutes: 0, sessionCount: 0 },
  };

  let unknownTrackMinutes = 0;
  let totalMinutes = 0;

  for (const row of rows) {
    const minutes = Math.max(0, Math.round(row.minutes));
    if (!Number.isFinite(minutes) || minutes === 0) continue;
    totalMinutes += minutes;

    const track = row.track as LearningTrack;
    if (track === 'GENERAL_ENGLISH' || track === 'IELTS_PREPARATION' || track === 'ENGLISH_MEDIATED_LEARNING') {
      buckets[track].minutes += minutes;
      buckets[track].sessionCount += 1;
    } else {
      buckets.GENERAL_ENGLISH.minutes += minutes;
      buckets.GENERAL_ENGLISH.sessionCount += 1;
      unknownTrackMinutes += minutes;
    }
  }

  const stats: TrackStatDto[] = (
    ['GENERAL_ENGLISH', 'IELTS_PREPARATION', 'ENGLISH_MEDIATED_LEARNING'] as LearningTrack[]
  ).map((track) => ({
    track,
    labelZh: TRACK_LABEL[track],
    minutes: buckets[track].minutes,
    sessionCount: buckets[track].sessionCount,
    shareOfTotal: totalMinutes > 0 ? buckets[track].minutes / totalMinutes : null,
  }));

  return { stats, totalMinutes, unknownTrackMinutes };
}

// ───────────────────────── 通用英语 gate ─────────────────────────

/** 一条 CEFR 评估证据（只取 gate 需要的字段）。 */
export interface AssessmentEvidence {
  skill: AllocationSkill | string;
  cefrLevel: CefrLevel | string;
  assessDate: string;
  confidence: number;
}

/** gate 未满足项。 */
export interface GateGap {
  code: string;
  label: string;
  current: string;
  target: string;
}

/** 单个目标的 gate 结果。 */
export interface TrackGateResult {
  /** 是否建议进入下一阶段（或判定目标达成）。 */
  suggested: boolean;
  /** 未满足项；空数组 = 全部满足。 */
  gaps: GateGap[];
  /** 判定依据的一句话说明（UI 必须原样展示，让用户知道凭什么）。 */
  basis: string;
}

/**
 * General English gate。
 *
 * 判定条件（全部满足才 suggested）：
 * ① 四项技能**各自**至少有 `GE_GATE_MIN_ASSESSMENTS_PER_SKILL` 条评估证据；
 * ② 每项技能**最近一条**评估等级 ≥ 目标等级（按 CEFR_RANK 比较）。
 *
 * **注意**：`totalMinutes` 参数只用于文案（「你已学 X 小时」），
 * 绝不参与判定。学了 500 小时但四项都没有评估 → 仍然不通过。
 */
export function evaluateGeneralEnglishGate(input: {
  assessments: AssessmentEvidence[];
  targetLevel: CefrLevel;
  totalMinutes: number;
}): TrackGateResult {
  const gaps: GateGap[] = [];
  const targetRank = CEFR_RANK[input.targetLevel] ?? 4;

  const bySkill = new Map<string, AssessmentEvidence[]>();
  for (const item of input.assessments) {
    const list = bySkill.get(item.skill) ?? [];
    list.push(item);
    bySkill.set(item.skill, list);
  }

  const levelText: string[] = [];
  for (const skill of ALLOCATION_SKILLS) {
    const list = (bySkill.get(skill) ?? []).slice().sort((a, b) => (a.assessDate < b.assessDate ? -1 : 1));
    if (list.length < GE_GATE_MIN_ASSESSMENTS_PER_SKILL) {
      gaps.push({
        code: `GE_EVIDENCE_${skill}`,
        label: `${skill} 缺少能力评估证据`,
        current: `${list.length} 条`,
        target: `≥ ${GE_GATE_MIN_ASSESSMENTS_PER_SKILL} 条`,
      });
      continue;
    }
    const latest = list[list.length - 1];
    const latestRank = CEFR_RANK[latest.cefrLevel as CefrLevel] ?? 0;
    levelText.push(`${skill}=${latest.cefrLevel}`);
    if (latestRank < targetRank) {
      gaps.push({
        code: `GE_LEVEL_${skill}`,
        label: `${skill} 最近评估未达目标等级`,
        current: latest.cefrLevel,
        target: input.targetLevel,
      });
    }
  }

  const suggested = gaps.length === 0;
  const hours = Math.round(input.totalMinutes / 60);

  return {
    suggested,
    gaps,
    basis: suggested
      ? `四项技能均有评估证据且最近等级均达 ${input.targetLevel}（${levelText.join('，')}）。学习时长 ${hours} 小时仅作参考，不参与判定。`
      : `共 ${gaps.length} 项未满足。学习时长 ${hours} 小时不构成升级依据 —— 时长充足但缺少评估证据时不会自动判级。`,
  };
}

// ───────────────────────── IELTS gate ─────────────────────────

/** 一条 IELTS 成绩（只取 gate 需要的字段）。 */
export interface IeltsEvidence {
  testDate: string;
  testType: 'OFFICIAL' | 'MOCK' | 'PRACTICE' | string;
  overallBand: number;
  listeningBand: number | null;
  readingBand: number | null;
  writingBand: number | null;
  speakingBand: number | null;
}

/** IELTS 目标。 */
export interface IeltsTarget {
  overall: number;
  listening: number | null;
  reading: number | null;
  writing: number | null;
  speaking: number | null;
}

/**
 * IELTS gate。
 *
 * 判定条件：取**最近 `IELTS_GATE_MAX_RECORDS` 条有效成绩**（`OFFICIAL` 或 `MOCK`，
 * 排除 `PRACTICE` 单项练习），要求
 * ① 至少 `IELTS_GATE_MIN_RECORDS` 条；
 * ② **每一条**的总分与已配置单项都 ≥ 目标（「稳定达到」，不是偶尔一次）。
 *
 * **本函数不读 CEFR 数据，也不向 CEFR 写任何东西** —— 成绩独立性由结构保证。
 */
export function evaluateIeltsGate(input: {
  records: IeltsEvidence[];
  target: IeltsTarget;
}): TrackGateResult {
  const valid = input.records
    .filter((r) => r.testType === 'OFFICIAL' || r.testType === 'MOCK')
    .slice()
    .sort((a, b) => (a.testDate < b.testDate ? 1 : -1)) // 新 → 旧
    .slice(0, IELTS_GATE_MAX_RECORDS);

  if (valid.length < IELTS_GATE_MIN_RECORDS) {
    return {
      suggested: false,
      gaps: [
        {
          code: 'IELTS_RECORDS',
          label: '有效模考/正式成绩不足',
          current: `${valid.length} 条`,
          target: `≥ ${IELTS_GATE_MIN_RECORDS} 条（最近 ${IELTS_GATE_MAX_RECORDS} 次）`,
        },
      ],
      basis: `只有 ${valid.length} 条有效成绩，无法判断「稳定达到」。单项练习（PRACTICE）不计入。`,
    };
  }

  const gaps: GateGap[] = [];
  const checks: { key: keyof IeltsTarget; label: string; pick: (r: IeltsEvidence) => number | null }[] = [
    { key: 'overall', label: '总分', pick: (r) => r.overallBand },
    { key: 'listening', label: '听力', pick: (r) => r.listeningBand },
    { key: 'reading', label: '阅读', pick: (r) => r.readingBand },
    { key: 'writing', label: '写作', pick: (r) => r.writingBand },
    { key: 'speaking', label: '口语', pick: (r) => r.speakingBand },
  ];

  for (const check of checks) {
    const target = input.target[check.key];
    if (target === null || target === undefined) continue;

    const values = valid.map(check.pick);
    const missing = values.some((value) => value === null);
    if (missing) {
      gaps.push({
        code: `IELTS_MISSING_${check.key.toUpperCase()}`,
        label: `${check.label}有成绩缺失`,
        current: '不完整',
        target: `每次 ≥ ${target}`,
      });
      continue;
    }
    const lowest = Math.min(...(values as number[]));
    if (lowest < target) {
      gaps.push({
        code: `IELTS_${check.key.toUpperCase()}`,
        label: `${check.label}未稳定达标`,
        current: `最低 ${lowest}`,
        target: `每次 ≥ ${target}`,
      });
    }
  }

  const suggested = gaps.length === 0;
  return {
    suggested,
    gaps,
    basis: suggested
      ? `最近 ${valid.length} 次有效成绩均达到目标（总分 ≥ ${input.target.overall}）。此判定只看 IELTS 成绩，不影响 CEFR 估计。`
      : `最近 ${valid.length} 次中存在未达标项，共 ${gaps.length} 项。`,
  };
}

// ───────────────────────── 媒介学习 gate ─────────────────────────

/** 一条媒介学习记录（gate 需要的字段）。 */
export interface MediatedEvidence {
  sessionDate: string;
  primarySkill: string;
  durationMinutes: number;
  understanding: MediatedUnderstanding | string;
  translationDependency: TranslationDependency | string;
  /** 英文笔记/摘要/问题的条数（已剥离空串）。 */
  outputCount: number;
  /** 摘要字数（用于判断「有没有真产出」）。 */
  summaryChars: number;
}

const VALID_SKILLS = new Set(['LISTENING', 'READING', 'SPEAKING', 'WRITING']);

/**
 * 英语媒介学习 gate。
 *
 * 判定条件（全部满足才 suggested）：
 * ① 有效记录次数 ≥ 门槛（试学 3 次 / 系统化 6 次）；
 *    「有效」= 有英文产出（笔记/摘要/问题任一）**且** `understanding !== 'LOW'`；
 * ② 有效记录里四项语言技能各自至少出现 1 次（说明不是只靠一种技能在学）；
 * ③ 最近 3 条（按日期）理解度均值 ≥ 0.6（至少「需字幕辅助」水平）；
 * ④ 翻译独立度均值 ≥ `MEDIATED_INDEPENDENCE_PASS`（0.7）。
 *
 * A2–B1 阶段用试学门槛（3 次），B1 之后用系统化门槛（6 次）。
 */
export function evaluateMediatedGate(input: {
  records: MediatedEvidence[];
  intensity: MediatedIntensity;
}): TrackGateResult {
  const isTrial = input.intensity === 'A2_B1' || input.intensity === 'PRE_A2';
  const minSessions = isTrial ? MEDIATED_GATE_MIN_SESSIONS_TRIAL : MEDIATED_GATE_MIN_SESSIONS_SYSTEMATIC;

  const sorted = input.records.slice().sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : 1));

  const effective = sorted.filter(
    (r) =>
      r.outputCount > 0 &&
      r.understanding !== 'LOW' &&
      VALID_SKILLS.has(r.primarySkill) &&
      r.durationMinutes > 0,
  );

  const gaps: GateGap[] = [];

  if (effective.length < minSessions) {
    gaps.push({
      code: 'MEDIATED_SESSIONS',
      label: '有效媒介学习记录不足',
      current: `${effective.length} 次`,
      target: `≥ ${minSessions} 次（须有英文产出且理解度非「无法理解」）`,
    });
  }

  const skillsSeen = new Set(effective.map((r) => r.primarySkill));
  const missingSkills = ALLOCATION_SKILLS.filter((skill) => !skillsSeen.has(skill));
  if (missingSkills.length > 0 && effective.length > 0) {
    gaps.push({
      code: 'MEDIATED_SKILLS',
      label: '技能覆盖面不足',
      current: `已用 ${[...skillsSeen].join('/') || '无'}`,
      target: `四项技能各自至少 1 次（缺 ${missingSkills.join('/')}）`,
    });
  }

  // 理解度与翻译独立度：取最近 3 条有效记录
  const recent = effective.slice(-3);
  let understandAvg: number | null = null;
  let independenceAvg: number | null = null;

  if (recent.length > 0) {
    understandAvg =
      recent.reduce((sum, r) => sum + (UNDERSTANDING_SCORE[r.understanding as MediatedUnderstanding] ?? 0), 0) /
      recent.length;
    independenceAvg =
      recent.reduce(
        (sum, r) => sum + (TRANSLATION_INDEPENDENCE_SCORE[r.translationDependency as TranslationDependency] ?? 0),
        0,
      ) / recent.length;

    if (understandAvg < MEDIATED_UNDERSTANDING_PASS - FLOAT_EPSILON) {
      gaps.push({
        code: 'MEDIATED_UNDERSTANDING',
        label: '理解度不足',
        current: understandAvg.toFixed(2),
        target: `≥ ${MEDIATED_UNDERSTANDING_PASS.toFixed(2)}（至少「需字幕辅助」）`,
      });
    }
    if (independenceAvg < MEDIATED_INDEPENDENCE_PASS - FLOAT_EPSILON) {
      gaps.push({
        code: 'MEDIATED_INDEPENDENCE',
        label: '中文翻译依赖偏高',
        current: independenceAvg.toFixed(2),
        target: `≥ ${MEDIATED_INDEPENDENCE_PASS.toFixed(2)}（接近「英文字幕级」独立度）`,
      });
    }
  }

  const suggested = gaps.length === 0 && effective.length > 0;
  return {
    suggested,
    gaps,
    basis: suggested
      ? `${effective.length} 次有效记录（门槛 ${minSessions}），四项技能均有覆盖；最近 ${recent.length} 次理解度均值 ${understandAvg?.toFixed(2)}、翻译独立度 ${independenceAvg?.toFixed(2)}。此项独立验收，不受 IELTS 分数影响。`
      : `有效记录 ${effective.length} 次，共 ${gaps.length} 项未满足。此项只看媒介学习证据，与 CEFR 评估、IELTS 成绩互不替代。`,
  };
}

// ───────────────────────── 目标进度 ─────────────────────────

/**
 * 目标达成度（0..1）。**证据不足返回 `null`**，绝不返回 0 冒充「毫无进展」。
 */
export function goalProgress(input: {
  achievedCount: number;
  totalCount: number;
}): number | null {
  if (input.totalCount <= 0) return null;
  return Math.max(0, Math.min(1, input.achievedCount / input.totalCount));
}

/** 有效产出的过滤条件（供查询层与测试共用）。 */
export function isMediatedEvidenceOutput(outputType: string): boolean {
  return (MEDIATED_EVIDENCE_OUTPUTS as string[]).includes(outputType);
}

/**
 * 一次媒介学习记录的「有效产出数」。
 *
 * 口径唯一：结构化 `LearningOutput` 条数 + 三个内联英文文本字段（笔记/摘要/问题）
 * 任一非空各算 1。查询层（`goals.ts` / `mediated.ts`）都必须走这里，避免各写各的
 * 导致 gate 判定与列表展示数字不一致。
 */
export function mediatedOutputCount(input: {
  outputCount: number;
  notesEn: string | null | undefined;
  summaryEn: string | null | undefined;
  questionsEn: string | null | undefined;
}): number {
  const inline = [input.notesEn, input.summaryEn, input.questionsEn].filter(
    (text) => Boolean(text && text.trim().length > 0),
  ).length;
  return input.outputCount + inline;
}
