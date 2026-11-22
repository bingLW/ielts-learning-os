/**
 * 诊断后的计划草案生成（确定性规则）。
 *
 * 约束：
 * 1. 必须使用 v2.1 动态时间预算，不假设每天 240 分钟；
 * 2. 每个任务写明关联证据（哪个技能画像的缺口）与安排原因；
 * 3. 只生成 DRAFT，用户确认后才 ACTIVE，且不自动创建 PlanTask。
 */

import { levelIndex, type DiagnosticSkill } from './constants';

export interface PlanTaskDraft {
  title: string;
  minutes: number;
  skill: DiagnosticSkill | 'META';
  evidenceRef: string;
  reason: string;
}

export interface PlanPhase {
  window: '7D' | '30D' | '90D';
  focus: string;
  tasks: PlanTaskDraft[];
}

export interface PlanBudgetInput {
  weeklyTargetMinutes: number | null;
  weekdayProfiles: number[];
  defaultDailyMinutes: number;
  isUserConfirmed: boolean;
}

export interface PlanProfileInput {
  skill: DiagnosticSkill;
  estimatedLevel: string | null;
  levelRange: [string, string] | null;
  confidence: string;
  needsFollowUp: boolean;
  evidenceCount: number;
}

export interface PlanDraft {
  phases: PlanPhase[];
  rationale: { notes: string[]; budget: PlanBudgetInput; generatedBy: string };
  budget: {
    weeklyMinutes: number;
    dailyAverage: number;
    source: 'WEEKLY_TARGET' | 'WEEKDAY_PROFILES' | 'INITIAL_SUGGESTION';
  };
}

const TRAINING: Partial<Record<DiagnosticSkill, { title: string; note: string }>> = {
  LISTENING: { title: '精听：短对话与公告', note: '听力画像缺口' },
  READING: { title: '精读：段落主旨与指代', note: '阅读画像缺口' },
  SPEAKING: { title: '口语：每日 60 秒独白 + 追问', note: '口语画像缺口' },
  WRITING: { title: '写作：80–120 词短文并自查', note: '写作画像缺口' },
  GRAMMAR: { title: '语法抽样：错题对应规则', note: '语法辅助画像缺口' },
  VOCABULARY: { title: '词汇：情境义与搭配', note: '词汇辅助画像缺口' },
  SENTENCE_STRUCTURE: { title: '句子主干拆解练习', note: '句子结构辅助画像缺口' },
  EMLR: { title: '英语媒介学习：短材料复述', note: '媒介学习准备度画像' },
};

function budgetOf(input: PlanBudgetInput): PlanDraft['budget'] {
  const profileSum = input.weekdayProfiles.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (input.weeklyTargetMinutes && input.weeklyTargetMinutes > 0) {
    return {
      weeklyMinutes: input.weeklyTargetMinutes,
      dailyAverage: Math.round(input.weeklyTargetMinutes / 7),
      source: 'WEEKLY_TARGET',
    };
  }
  if (profileSum > 0) {
    return {
      weeklyMinutes: profileSum,
      dailyAverage: Math.round(profileSum / 7),
      source: 'WEEKDAY_PROFILES',
    };
  }
  const weekly = Math.max(0, input.defaultDailyMinutes) * 6;
  return {
    weeklyMinutes: weekly,
    dailyAverage: Math.round(weekly / 7),
    source: 'INITIAL_SUGGESTION',
  };
}

function rankWeak(profiles: PlanProfileInput[]): PlanProfileInput[] {
  return [...profiles].sort((a, b) => {
    const aIndex = a.estimatedLevel
      ? levelIndex(a.estimatedLevel)
      : levelIndex(a.levelRange?.[0] ?? 'Pre-A1');
    const bIndex = b.estimatedLevel
      ? levelIndex(b.estimatedLevel)
      : levelIndex(b.levelRange?.[0] ?? 'Pre-A1');
    if (aIndex !== bIndex) return aIndex - bIndex;
    return Number(b.needsFollowUp) - Number(a.needsFollowUp);
  });
}

export function buildPlanDraft(
  profiles: PlanProfileInput[],
  budgetInput: PlanBudgetInput,
): PlanDraft {
  const budget = budgetOf(budgetInput);
  const weak = rankWeak(profiles.filter((profile) => profile.evidenceCount > 0));
  const followUps = profiles.filter((profile) => profile.needsFollowUp);
  const notes: string[] = [
    `每周预算 ${budget.weeklyMinutes} 分钟（来源：${budget.source}），未按每天 240 分钟假设。`,
    budgetInput.isUserConfirmed
      ? '预算来自用户已确认的计划设置。'
      : '预算仍为初始建议值（尚未被用户确认），执行前请先在系统设置中核对。',
  ];

  const phase7: PlanTaskDraft[] = [];
  let used = 0;
  for (const profile of followUps.slice(0, 3)) {
    if (used + 20 > budget.weeklyMinutes) break;
    phase7.push({
      title: `补测：${profile.skill} 平行题`,
      minutes: 20,
      skill: profile.skill,
      evidenceRef: `SkillProfile:${profile.skill}`,
      reason: `${profile.skill} 当前置信度不足（${profile.confidence}），先补测再定训练强度。`,
    });
    used += 20;
  }

  const rotation = weak.slice(0, 3);
  const perTask = Math.max(15, Math.min(30, Math.floor(Math.max(0, budget.weeklyMinutes - used) / Math.max(1, rotation.length * 2))));
  for (const profile of rotation) {
    const training = TRAINING[profile.skill];
    if (!training) continue;
    if (used + perTask > budget.weeklyMinutes) break;
    phase7.push({
      title: training.title,
      minutes: perTask,
      skill: profile.skill,
      evidenceRef: `SkillProfile:${profile.skill}`,
      reason: `${training.note}（当前 ${profile.estimatedLevel ?? profile.levelRange?.join('–') ?? '暂不能判断'}）。`,
    });
    used += perTask;
  }

  if (phase7.length === 0) {
    phase7.push({
      title: '完成初始诊断补测',
      minutes: 20,
      skill: 'META',
      evidenceRef: 'DiagnosticReport',
      reason: '当前没有可用画像，先补齐诊断再做训练安排。',
    });
  }

  const phase30: PlanTaskDraft[] = rotation.slice(0, 2).map((profile) => {
    const training = TRAINING[profile.skill] ?? {
      title: '综合训练',
      note: '综合能力',
    };
    return {
      title: `每周 3 次：${training.title}`,
      minutes: Math.max(30, Math.min(90, perTask * 3)),
      skill: profile.skill,
      evidenceRef: `SkillProfile:${profile.skill}`,
      reason: `围绕最低画像技能建立稳定训练频率（${training.note}）。`,
    };
  });
  if (phase30.length === 0) {
    phase30.push({
      title: '每周 3 次基础训练',
      minutes: 60,
      skill: 'META',
      evidenceRef: 'DiagnosticReport',
      reason: '先建立学习节奏，补测后再细化技能分配。',
    });
  }

  const phase90: PlanTaskDraft[] = [
    {
      title: '延迟复测（平行材料）',
      minutes: 30,
      skill: 'META',
      evidenceRef: 'EvidenceChain:DELAYED_RETEST',
      reason: '验证进步是否稳定，不使用已见题目作为唯一证据。',
    },
    {
      title: '阶段验收：四项技能抽样',
      minutes: 40,
      skill: 'META',
      evidenceRef: 'DiagnosticSession:next',
      reason: '以新一轮诊断快照对比变化，不覆盖旧报告。',
    },
    {
      title: '迁移任务：换主题/场景应用',
      minutes: 30,
      skill: 'META',
      evidenceRef: 'EvidenceChain:TRANSFER',
      reason: '检查能力能否迁移到新材料，避免只记住原题。',
    },
  ];

  notes.push('所有任务为草案；确认后仅把计划标记为 ACTIVE，不会自动创建今日 PlanTask。');
  notes.push('补测与延迟复测使用平行题或新材料，避免熟悉效应。');

  return {
    phases: [
      { window: '7D', focus: '补测 + 启动最弱技能', tasks: phase7 },
      { window: '30D', focus: '建立训练频率', tasks: phase30 },
      { window: '90D', focus: '延迟复测与迁移验收', tasks: phase90 },
    ],
    rationale: { notes, budget: budgetInput, generatedBy: 'v2.4.1-deterministic-plan' },
    budget,
  };
}