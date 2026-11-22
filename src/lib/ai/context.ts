/**
 * Context Builder：只提供任务所需的最小上下文。
 *
 * 不注入全部历史；最近错误最多 5 条、最近证据最多 3 条，
 * 并优先取与当前技能相关的记录。纯函数，便于单测。
 */

import {
  AI_CONTEXT_LIMITS,
  AI_ERROR_CATEGORY_LABEL_ZH,
  type AiCoachSkill,
  type AiErrorCategory,
} from '@/lib/constants';
import type { AiContextSnapshot } from './types';

export interface ContextErrorInput {
  skill?: string | null;
  category: string;
  summary: string;
  occurredOn: string;
}

export interface ContextEvidenceInput {
  skill?: string | null;
  evidenceType: string;
  score: number | null;
  createdAt: string;
}

export interface BuildContextInput {
  track: string;
  ieltsTargetNote?: string | null;
  skill: AiCoachSkill;
  profile?: { cefrEstimate: string; confidence: string } | null;
  stage?: { name: string; focus: string; acceptance?: string | null } | null;
  errors?: ContextErrorInput[];
  evidence?: ContextEvidenceInput[];
  explainLanguage: string;
  directTeachingAllowed: boolean;
  remainingMinutes?: number | null;
}

function relevanceRank(skill: string | null | undefined, target: string): number {
  if (!skill) return 1;
  return skill === target ? 0 : 1;
}

export function buildLearningContext(input: BuildContextInput): AiContextSnapshot {
  const errors = [...(input.errors ?? [])]
    .sort((a, b) => {
      const rank = relevanceRank(a.skill, input.skill) - relevanceRank(b.skill, input.skill);
      if (rank !== 0) return rank;
      return b.occurredOn.localeCompare(a.occurredOn);
    })
    .slice(0, AI_CONTEXT_LIMITS.recentErrors)
    .map((item) => ({
      category: item.category,
      summary: item.summary.slice(0, 200),
      occurredOn: item.occurredOn,
    }));

  const evidence = [...(input.evidence ?? [])]
    .sort((a, b) => {
      const rank = relevanceRank(a.skill, input.skill) - relevanceRank(b.skill, input.skill);
      if (rank !== 0) return rank;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, AI_CONTEXT_LIMITS.recentEvidence)
    .map((item) => ({
      evidenceType: item.evidenceType,
      score: item.score,
      createdAt: item.createdAt,
    }));

  return {
    track: input.track,
    ieltsTargetNote: input.ieltsTargetNote ?? null,
    skill: input.skill,
    profile: input.profile ?? null,
    stage: input.stage
      ? {
          name: input.stage.name,
          focus: input.stage.focus,
          acceptance: input.stage.acceptance ?? null,
        }
      : null,
    recentErrors: errors,
    recentEvidence: evidence,
    explainLanguage: input.explainLanguage,
    directTeachingAllowed: input.directTeachingAllowed,
    remainingMinutes:
      typeof input.remainingMinutes === 'number' ? input.remainingMinutes : null,
    limits: {
      maxErrors: AI_CONTEXT_LIMITS.recentErrors,
      maxEvidence: AI_CONTEXT_LIMITS.recentEvidence,
    },
  };
}

function categoryLabel(category: string): string {
  return AI_ERROR_CATEGORY_LABEL_ZH[category as AiErrorCategory] ?? category;
}

/** 把上下文压缩成一段可放进 Prompt 的中文摘要。 */
export function renderContextSummary(snapshot: AiContextSnapshot): string {
  const parts: string[] = [`轨道：${snapshot.track}`];
  if (snapshot.ieltsTargetNote) parts.push(`考试目标：${snapshot.ieltsTargetNote}`);
  if (snapshot.profile) {
    parts.push(
      `${snapshot.skill} 当前估计 ${snapshot.profile.cefrEstimate}（置信度 ${snapshot.profile.confidence}）`,
    );
  }
  if (snapshot.stage) {
    const acceptance = snapshot.stage.acceptance
      ? `；验收：${snapshot.stage.acceptance}`
      : '';
    parts.push(`阶段：${snapshot.stage.name}（重点：${snapshot.stage.focus}${acceptance}）`);
  }
  if (snapshot.recentErrors.length > 0) {
    parts.push(
      `最近错误：${snapshot.recentErrors
        .map((item) => `${categoryLabel(item.category)}-${item.summary}`)
        .join('；')}`,
    );
  }
  if (snapshot.recentEvidence.length > 0) {
    parts.push(
      `最近证据：${snapshot.recentEvidence
        .map(
          (item) =>
            `${item.evidenceType}=${item.score === null ? '未评分' : item.score}`,
        )
        .join('；')}`,
    );
  }
  parts.push(`解释语言：${snapshot.explainLanguage}`);
  if (snapshot.remainingMinutes !== null) {
    parts.push(`今天剩余时间约 ${snapshot.remainingMinutes} 分钟`);
  }
  return parts.join('；');
}

/** 序列化写入数据库，限制体积。 */
export function serializeContext(snapshot: AiContextSnapshot): string {
  return JSON.stringify(snapshot);
}