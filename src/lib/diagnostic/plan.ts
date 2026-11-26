/**
 * 诊断后的计划草案生成（确定性规则）。
 *
 * 约束：
 * 1. 必须使用 v2.1 动态时间预算，不假设每天 240 分钟；
 * 2. 每个任务写明关联证据（哪个技能画像的缺口）与安排原因；
 * 3. 只生成 DRAFT，不自动创建 PlanTask；正式启用由 Planner 后续流程负责。
 */

import { addDays, isValidDateString } from '@/lib/date';
import type { EffectiveBudget } from '@/lib/domain/budget';
import type { BudgetSource } from '@/lib/types';
import { levelIndex, type DiagnosticSkill } from './constants';

export interface PlanTaskDraft {
  title: string;
  minutes: number;
  skill: DiagnosticSkill | 'META';
  evidenceRef: string;
  reason: string;
}

export interface PlanBudgetWindowSummary {
  window: '7D' | '30D' | '90D';
  startDate: string;
  endDate: string;
  days: number;
  totalMinutes: number;
  dailyAverage: number;
  source: BudgetSource | 'MIXED';
}

export interface PlanBudgetWindow extends PlanBudgetWindowSummary {
  daily: PlanBudgetInput[];
}

export interface PlanPhase {
  window: '7D' | '30D' | '90D';
  focus: string;
  tasks: PlanTaskDraft[];
  /** 本阶段任务总量只能使用这个窗口的预算，不能借用其它阶段。 */
  budget: PlanBudgetWindowSummary;
}

/** 只接收 domain/budget.resolveEffectiveBudget 已解析的逐日结果。 */
export type PlanBudgetInput = Pick<
  EffectiveBudget,
  'date' | 'minutes' | 'isRestDay' | 'isSuggestion' | 'source'
>;

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
  rationale: { notes: string[]; budget: PlanBudgetInput[]; generatedBy: string };
  budget: {
    /** 兼容旧展示：7D 总量、7D 日均和 7D 来源。 */
    weeklyMinutes: number;
    dailyAverage: number;
    source: BudgetSource | 'MIXED';
    /** 三个窗口的精确汇总与逐日明细，是预算审计的真值。 */
    exact: Record<'7D' | '30D' | '90D', PlanBudgetWindow>;
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

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 } as const;

/** 校验并补齐日期顺序；缺少预算时拒绝猜测，避免把缺数据误当成 0 分钟。 */
function orderedDailyBudgets(input: PlanBudgetInput[], asOfDate: string): PlanBudgetInput[] {
  if (!isValidDateString(asOfDate)) {
    throw new RangeError(`无效的计划基准日：${asOfDate}`);
  }
  const byDate = new Map<string, PlanBudgetInput>();
  for (const day of input) {
    if (byDate.has(day.date)) throw new RangeError(`重复的已解析预算日期：${day.date}`);
    byDate.set(day.date, day);
  }

  return Array.from({ length: WINDOW_DAYS['90D'] }, (_, offset) => {
    const date = addDays(asOfDate, offset);
    const day = byDate.get(date);
    if (!day) throw new RangeError(`缺少 ${date} 的已解析预算`);
    if (!Number.isFinite(day.minutes) || day.minutes < 0) {
      throw new RangeError(`${date} 的已解析预算分钟数无效：${day.minutes}`);
    }
    return day;
  });
}

function summarizeWindow(
  window: keyof typeof WINDOW_DAYS,
  daily: PlanBudgetInput[],
  asOfDate: string,
): PlanBudgetWindow {
  const days = WINDOW_DAYS[window];
  const windowDays = daily.slice(0, days).map((day) => ({
    date: day.date,
    minutes: day.isRestDay ? 0 : day.minutes,
    isRestDay: day.isRestDay,
    isSuggestion: day.isSuggestion,
    source: day.source,
  }));
  const totalMinutes = windowDays.reduce((sum, day) => sum + day.minutes, 0);
  const firstSource = windowDays[0].source;
  const source = windowDays.every((day) => day.source === firstSource && !day.isSuggestion)
    ? firstSource
    : 'MIXED';

  return {
    window,
    startDate: asOfDate,
    endDate: addDays(asOfDate, days - 1),
    days,
    totalMinutes,
    dailyAverage: totalMinutes / days,
    source,
    daily: windowDays,
  };
}

/** 按当前窗口剩余分钟收紧任务；0 预算时不制造兜底任务。 */
function addTaskWithinBudget(
  tasks: PlanTaskDraft[],
  usedMinutes: number,
  task: PlanTaskDraft,
  totalBudget: number,
): number {
  const remaining = totalBudget - usedMinutes;
  if (remaining < 5) return usedMinutes;
  if (task.minutes > remaining) return usedMinutes;
  tasks.push(task);
  return usedMinutes + task.minutes;
}

function windowSummary(budget: PlanBudgetWindow): PlanBudgetWindowSummary {
  return {
    window: budget.window,
    startDate: budget.startDate,
    endDate: budget.endDate,
    days: budget.days,
    totalMinutes: budget.totalMinutes,
    dailyAverage: budget.dailyAverage,
    source: budget.source,
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
  budgetInput: PlanBudgetInput[],
  asOfDate: string,
): PlanDraft {
  const daily = orderedDailyBudgets(budgetInput, asOfDate);
  const exact = {
    '7D': summarizeWindow('7D', daily, asOfDate),
    '30D': summarizeWindow('30D', daily, asOfDate),
    '90D': summarizeWindow('90D', daily, asOfDate),
  };
  const budget = {
    weeklyMinutes: exact['7D'].totalMinutes,
    dailyAverage: Math.round(exact['7D'].dailyAverage),
    source: exact['7D'].source,
    exact,
  };
  const weak = rankWeak(profiles.filter((profile) => profile.evidenceCount > 0));
  const followUps = profiles.filter((profile) => profile.needsFollowUp);
  const notes: string[] = [
    `每周预算 ${budget.weeklyMinutes} 分钟（来源：${budget.source}），未按每天 240 分钟假设。`,
    exact['90D'].daily.some((day) => day.isSuggestion)
      ? '预算含系统建议值（尚未被用户确认），执行前请先在系统设置中核对。'
      : '预算来自用户已确认的逐日计划设置。',
    `30D 窗口 ${exact['30D'].startDate} 至 ${exact['30D'].endDate} 共 ${exact['30D'].totalMinutes} 分钟；90D 窗口共 ${exact['90D'].totalMinutes} 分钟，各阶段任务分别受本窗口预算约束。`,
  ];

  const phase7: PlanTaskDraft[] = [];
  let used = 0;
  const canSchedule7D = exact['7D'].daily.some((day) => !day.isRestDay && day.minutes >= 5);
  if (canSchedule7D) {
    for (const profile of followUps.slice(0, 3)) {
      used = addTaskWithinBudget(phase7, used, {
        title: `补测：${profile.skill} 平行题`,
        minutes: 20,
        skill: profile.skill,
        evidenceRef: `SkillProfile:${profile.skill}`,
        reason: `${profile.skill} 当前置信度不足（${profile.confidence}），先补测再定训练强度。`,
      }, exact['7D'].totalMinutes);
    }
  }

  const rotation = weak.slice(0, 3);
  const perTask = Math.min(30, Math.floor(
    Math.max(0, exact['7D'].totalMinutes - used) / Math.max(1, rotation.length * 2),
  ));
  if (canSchedule7D) {
    for (const profile of rotation) {
      const training = TRAINING[profile.skill];
      if (!training || perTask < 5) continue;
      used = addTaskWithinBudget(phase7, used, {
        title: training.title,
        minutes: perTask,
        skill: profile.skill,
        evidenceRef: `SkillProfile:${profile.skill}`,
        reason: `${training.note}（当前 ${profile.estimatedLevel ?? profile.levelRange?.join('–') ?? '暂不能判断'}）。`,
      }, exact['7D'].totalMinutes);
    }
  }

  if (phase7.length === 0 && canSchedule7D) {
    addTaskWithinBudget(phase7, 0, {
      title: '完成初始诊断补测',
      minutes: 20,
      skill: 'META',
      evidenceRef: 'DiagnosticReport',
      reason: '当前没有可用画像，先补齐诊断再做训练安排。',
    }, exact['7D'].totalMinutes);
  }

  const phase30: PlanTaskDraft[] = [];
  let used30 = 0;
  const canSchedule30D = exact['30D'].daily.some((day) => !day.isRestDay && day.minutes >= 5);
  if (canSchedule30D) {
    for (const profile of rotation.slice(0, 2)) {
      const training = TRAINING[profile.skill] ?? {
        title: '综合训练',
        note: '综合能力',
      };
      used30 = addTaskWithinBudget(phase30, used30, {
        title: `每周 3 次：${training.title}`,
        minutes: Math.max(30, Math.min(90, perTask * 3)),
        skill: profile.skill,
        evidenceRef: `SkillProfile:${profile.skill}`,
        reason: `围绕最低画像技能建立稳定训练频率（${training.note}），总量受 30D 窗口约束。`,
      }, exact['30D'].totalMinutes);
    }
  }
  if (phase30.length === 0 && canSchedule30D) {
    addTaskWithinBudget(phase30, 0, {
      title: '每周 3 次基础训练',
      minutes: 60,
      skill: 'META',
      evidenceRef: 'DiagnosticReport',
      reason: '先建立学习节奏，补测后再细化技能分配；总量受 30D 窗口约束。',
    }, exact['30D'].totalMinutes);
  }

  const phase90: PlanTaskDraft[] = [];
  let used90 = 0;
  const phase90Candidates: PlanTaskDraft[] = [
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
  const canSchedule90D = exact['90D'].daily.some((day) => !day.isRestDay && day.minutes >= 5);
  if (canSchedule90D) {
    for (const task of phase90Candidates) {
      used90 = addTaskWithinBudget(phase90, used90, task, exact['90D'].totalMinutes);
    }
  }

  notes.push('所有任务为草案；保存后进入 Planner 预览，再次确认才写入正式计划，不会自动创建今日 PlanTask。');
  notes.push('补测与延迟复测使用平行题或新材料，避免熟悉效应。');

  return {
    phases: [
      { window: '7D', focus: '补测 + 启动最弱技能', tasks: phase7, budget: windowSummary(exact['7D']) },
      { window: '30D', focus: '建立训练频率', tasks: phase30, budget: windowSummary(exact['30D']) },
      { window: '90D', focus: '延迟复测与迁移验收', tasks: phase90, budget: windowSummary(exact['90D']) },
    ],
    rationale: { notes, budget: daily, generatedBy: 'v2.7.1-deterministic-plan' },
    budget,
  };
}