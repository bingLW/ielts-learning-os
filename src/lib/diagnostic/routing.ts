/**
 * 确定性诊断逻辑：客观题判分、难度路由、证据聚合、画像与报告草稿。
 *
 * 这里不调用任何模型，全部是纯函数，便于单元测试与解释。
 * AI 只用于开放任务评分（见 `ai.ts`），且结果必须通过 schema 校验。
 */

import {
  DIAG_LEVELS,
  DIFFICULTY_LEVEL,
  DIAG_MAX_ATTEMPTS_PER_SKILL,
  DIAG_SAMPLES_HIGH,
  DIAG_SAMPLES_MEDIUM,
  DIAG_DISCLAIMER_ZH,
  levelIndex,
  type DiagnosticSkill,
  type DiagSourceType,
  type DiagLevel,
} from './constants';

// ── 客观题判分 ────────────────────────────────────────────────

export interface ObjectiveItemLike {
  taskType: string;
  correctAnswer: string | null;
  optionsJson: string | null;
}

export interface ObjectiveScore {
  score: 0 | 1 | 2;
  maxScore: 2;
  correct: boolean;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 客观题按题库答案确定性判分；不交给模型重新猜答案。 */
export function scoreObjectiveItem(
  item: ObjectiveItemLike,
  response: string,
): ObjectiveScore | null {
  if (item.taskType === 'OPEN_TASK') return null;
  const answer = (item.correctAnswer ?? '').trim();
  const given = response.trim();
  if (!answer || !given) return { score: 0, maxScore: 2, correct: false };

  let correct = false;
  if (item.taskType === 'MCQ') {
    correct = given.toUpperCase() === answer.toUpperCase();
    if (!correct && item.optionsJson) {
      try {
        const options = JSON.parse(item.optionsJson) as Array<{ key: string; text: string }>;
        const expected = options.find(
          (option) =>
            option.key.toUpperCase() === answer.toUpperCase() ||
            normalizeText(option.text) === normalizeText(answer),
        );
        // 容错：允许直接输入选项文本，不做模糊匹配以免误判。
        correct = Boolean(expected && normalizeText(given) === normalizeText(expected.text));
      } catch {
        correct = false;
      }
    }
  } else {
    correct = normalizeText(given) === normalizeText(answer);
  }
  return { score: correct ? 2 : 0, maxScore: 2, correct };
}

// ── 难度路由 ──────────────────────────────────────────────────

export interface RoutableItem {
  id: string;
  itemCode: string;
  skill: string;
  difficulty: number;
  sourceType: string;
  active: boolean;
}

export interface NextItemDecision {
  itemId: string | null;
  targetDifficulty: number;
  rationale: string;
}

/**
 * 基础题之后最多再补 1 题：答对升一档、答错降一档；
 * 只从已验证题中选，且排除已见题目，避免熟悉效应。
 */
export function decideNextObjectiveItem(input: {
  items: RoutableItem[];
  skill: DiagnosticSkill;
  attemptedCount: number;
  lastDifficulty: number;
  lastCorrect: boolean;
  seenItemIds: string[];
}): NextItemDecision {
  const target = Math.min(4, Math.max(1, input.lastDifficulty + (input.lastCorrect ? 1 : -1)));

  if (input.attemptedCount >= DIAG_MAX_ATTEMPTS_PER_SKILL) {
    return {
      itemId: null,
      targetDifficulty: target,
      rationale: `本技能已完成 ${input.attemptedCount} 题，达到本轮上限 ${DIAG_MAX_ATTEMPTS_PER_SKILL}；样本仍不足时会在报告中标注补测。`,
    };
  }

  const seen = new Set(input.seenItemIds);
  const candidates = input.items
    .filter(
      (item) =>
        item.skill === input.skill &&
        item.active &&
        item.sourceType === 'VERIFIED' &&
        !seen.has(item.id),
    )
    .sort((a, b) => {
      const distance = Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target);
      if (distance !== 0) return distance;
      return b.difficulty - a.difficulty;
    });

  const picked = candidates[0] ?? null;
  return {
    itemId: picked?.id ?? null,
    targetDifficulty: target,
    rationale: picked
      ? `${input.lastCorrect ? '答对' : '答错'}基础题，难度从 ${input.lastDifficulty} 调整到 ${target}，选用平行题 ${picked.itemCode}。`
      : `没有未曝光的平行题可用（目标难度 ${target}），本轮停止该技能并安排补测。`,
  };
}

// ── 等级换算与聚合 ────────────────────────────────────────────

export function levelBelow(level: string): DiagLevel {
  return DIAG_LEVELS[Math.max(0, levelIndex(level) - 1)];
}

export function levelForDifficulty(difficulty: number): DiagLevel {
  return DIFFICULTY_LEVEL[difficulty] ?? 'A2';
}

export interface SkillSample {
  skill: DiagnosticSkill;
  subskill: string;
  level: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  sourceType: DiagSourceType;
  /** 开放任务评分失败时为 true，只计覆盖不计等级。 */
  pending?: boolean;
}

export interface SkillProfileDraft {
  skill: DiagnosticSkill;
  estimatedLevel: string | null;
  levelRange: [string, string] | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  evidenceCount: number;
  coverageRatio: number;
  subskills: string[];
  needsFollowUp: boolean;
  limitations: string[];
}

/** 样本不足或冲突时只给范围；低置信度不给单一等级。 */
export function estimateSkillProfile(
  skill: DiagnosticSkill,
  samples: SkillSample[],
  expectedSubskills: string[],
): SkillProfileDraft {
  const usable = samples.filter((sample) => !sample.pending);
  const subskills = Array.from(new Set(usable.map((sample) => sample.subskill)));
  const coverageRatio = expectedSubskills.length
    ? Math.min(1, subskills.length / expectedSubskills.length)
    : usable.length > 0
      ? 1
      : 0;

  if (usable.length === 0) {
    return {
      skill,
      estimatedLevel: null,
      levelRange: null,
      confidence: 'LOW',
      evidenceCount: 0,
      coverageRatio,
      subskills,
      needsFollowUp: true,
      limitations: ['本轮没有有效证据，暂不能判断。'],
    };
  }

  const indices = usable.map((sample) => levelIndex(sample.level)).sort((a, b) => a - b);
  const min = indices[0];
  const max = indices[indices.length - 1];
  const median = indices[Math.floor((indices.length - 1) / 2)];
  const consistent = max - min <= 1;
  const hasLow = usable.some((sample) => sample.confidence === 'LOW');
  const hasRubric = usable.some((sample) => sample.sourceType === 'RUBRIC');

  let confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  if (usable.length >= DIAG_SAMPLES_HIGH && consistent && !hasLow) {
    confidence = 'HIGH';
  } else if (usable.length >= DIAG_SAMPLES_MEDIUM && consistent && !hasLow) {
    confidence = 'MEDIUM';
  }
  if (hasRubric && usable.length < DIAG_SAMPLES_MEDIUM) confidence = 'LOW';

  const limitations: string[] = [];
  if (usable.length < DIAG_SAMPLES_MEDIUM) {
    limitations.push(`有效样本仅 ${usable.length} 个，暂不能稳定定级。`);
  }
  if (!consistent) {
    limitations.push('不同任务表现不一致，等级存在冲突。');
  }
  if (hasLow) {
    limitations.push('部分任务评分置信度低，整体置信度被限制。');
  }
  if (coverageRatio < 0.5) {
    limitations.push('子维度覆盖不足一半。');
  }
  if (usable.some((sample) => sample.sourceType === 'RUBRIC')) {
    limitations.push('含 AI 辅助 rubric 评分，非官方认证；发音不得仅凭 ASR 转写判定。');
  }

  const estimateLow = confidence === 'LOW';
  const rangeLow = DIAG_LEVELS[estimateLow ? Math.max(0, min - 1) : min];
  const rangeHigh = DIAG_LEVELS[estimateLow ? Math.min(DIAG_LEVELS.length - 1, max + 1) : max];

  return {
    skill,
    estimatedLevel: estimateLow ? null : DIAG_LEVELS[median],
    levelRange: [rangeLow, rangeHigh],
    confidence,
    evidenceCount: usable.length,
    coverageRatio,
    subskills,
    needsFollowUp: confidence !== 'HIGH' || coverageRatio < 0.5,
    limitations,
  };
}

// ── 报告草稿 ──────────────────────────────────────────────────

export interface ReportDraft {
  summary: string;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  limitations: string[];
  provisional: boolean;
}

export function buildReportDraft(
  profiles: SkillProfileDraft[],
  skillLabel: (skill: DiagnosticSkill) => string,
  pendingCount: number,
): ReportDraft {
  const assessed = profiles.filter((profile) => profile.evidenceCount > 0);
  const ranked = [...assessed].sort((a, b) => {
    const aLevel = a.estimatedLevel ? levelIndex(a.estimatedLevel) : levelIndex(a.levelRange?.[1] ?? 'Pre-A1');
    const bLevel = b.estimatedLevel ? levelIndex(b.estimatedLevel) : levelIndex(b.levelRange?.[1] ?? 'Pre-A1');
    return bLevel - aLevel;
  });

  const strengths = ranked
    .slice(0, 2)
    .filter((profile) => profile.evidenceCount > 0)
    .map(
      (profile) =>
        `${skillLabel(profile.skill)}：${profile.estimatedLevel ?? profile.levelRange?.join('–') ?? '暂不能判断'}（${profile.evidenceCount} 条证据）`,
    );

  const gaps = [...assessed]
    .sort((a, b) => {
      const aLevel = a.estimatedLevel ? levelIndex(a.estimatedLevel) : levelIndex(a.levelRange?.[0] ?? 'Pre-A1');
      const bLevel = b.estimatedLevel ? levelIndex(b.estimatedLevel) : levelIndex(b.levelRange?.[0] ?? 'Pre-A1');
      return aLevel - bLevel;
    })
    .slice(0, 4)
    .map((profile) => {
      const target = profile.needsFollowUp ? '先补测' : '优先训练';
      return `${target}：${skillLabel(profile.skill)}（${profile.estimatedLevel ?? profile.levelRange?.join('–') ?? '暂不能判断'}）`;
    });

  const unassessed = profiles.filter((profile) => profile.evidenceCount === 0);
  if (unassessed.length > 0) {
    gaps.push(`未评估：${unassessed.map((profile) => skillLabel(profile.skill)).join('、')}（证据不足，暂不能判断）`);
  }

  const suggestions: string[] = [];
  if (profiles.some((profile) => profile.needsFollowUp)) {
    suggestions.push('先完成标注为「待补测」的技能，再根据补测结果调整计划。');
  }
  if (pendingCount > 0) {
    suggestions.push(`有 ${pendingCount} 个开放任务尚未完成评估，报告为暂定状态。`);
  }
  suggestions.push('计划草案必须由你确认后才会生效；可先修改任务、时间与教材。');

  const hasCoreMissing = profiles.some(
    (profile) => profile.evidenceCount === 0 || profile.confidence === 'LOW',
  );
  const confidence: ReportDraft['confidence'] = hasCoreMissing
    ? 'LOW'
    : profiles.some((profile) => profile.confidence === 'MEDIUM')
      ? 'MEDIUM'
      : 'HIGH';

  const summaryParts = profiles.map((profile) => {
    const label = skillLabel(profile.skill);
    if (profile.evidenceCount === 0) return `${label}：未评估`;
    if (!profile.estimatedLevel) {
      return `${label}：暂定 ${profile.levelRange?.[0]}–${profile.levelRange?.[1]}（${profile.confidence} 置信度，只给范围）`;
    }
    return `${label}：${profile.estimatedLevel}（范围 ${profile.levelRange?.[0]}–${profile.levelRange?.[1]}，${profile.confidence} 置信度）`;
  });

  return {
    summary: [
      'AI 辅助 CEFR 水平估计（四项技能分别呈现，不取平均）：',
      ...summaryParts.map((part) => `- ${part}`),
      `整体置信度：${confidence}。`,
    ].join('\n'),
    strengths,
    gaps,
    suggestions,
    confidence,
    limitations: [
      DIAG_DISCLAIMER_ZH,
      ...profiles.flatMap((profile) =>
        profile.limitations.map((item) => `${skillLabel(profile.skill)}：${item}`),
      ),
    ],
    provisional: hasCoreMissing || pendingCount > 0,
  };
}