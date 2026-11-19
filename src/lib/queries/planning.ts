/**
 * v2.1 计划引擎的输入装配（只读）。
 *
 * 引擎本身是纯函数；这里负责把数据库里的复习欠账与本周技能偏差
 * 整理成 `AdaptivePlanInput` 需要的形状。技能时间一律来自 `StudySession`
 * 的四技能快照（经 DaySplit 归日），不重复计时。
 */

import {
  CORE_MIN_RATIO,
  MIN_TASK_MINUTES,
  P0_CAP_RATIO,
  S0_MODULES,
  WEAKNESS_MIN_QUESTIONS,
  WEAKNESS_WINDOW_DAYS,
  type ResourceSubject,
} from '@/lib/constants';
import { addDays, diffDays, today, weekRange } from '@/lib/date';
import type { AdaptivePlanInput } from '@/lib/domain/adaptivePlan';
import { checkAllocation } from '@/lib/domain/allocation';
import { prisma } from '@/lib/prisma';
import type { AllocationSkill, ModuleId, SkillAllocation, StageCode } from '@/lib/types';

/** 科目 → 资源库 subject 的映射（用于自动挂主材料，代码中无资源名枚举）。 */
export const SKILL_TO_SUBJECT: Record<string, ResourceSubject | undefined> = {
  VOCAB: 'VOCAB',
  GRAMMAR: 'GRAMMAR',
  LISTENING: 'LISTENING',
  READING: 'READING',
  SPEAKING: 'SPEAKING',
  WRITING: 'WRITING',
  SENTENCE: 'GRAMMAR',
  META: undefined,
  LISTENING_EXT: 'LISTENING',
  READING_EXT: 'READING',
};

/** 主材料映射：`subject → resourceId`（只取 `isPrimary`）。 */
export async function primaryResourceMap(): Promise<Record<string, string>> {
  const resources = await prisma.resource.findMany({
    where: { archivedAt: null, isPrimary: true },
    select: { id: true, subject: true },
  });
  const map: Record<string, string> = {};
  for (const resource of resources) {
    if (!map[resource.subject]) map[resource.subject] = resource.id;
  }
  return map;
}

/**
 * 取某档当前生效的四技能配比。
 *
 * 返回 `null` 表示该档没有配置档案 —— 调用方据此**不做配平**，
 * 而不是拿一个硬编码默认值顶上（那会让「用户没配」和「用户配了 25/25/25/25」无法区分）。
 */
export async function activeAllocationFor(profileCode: string | null): Promise<SkillAllocation | null> {
  if (!profileCode) return null;
  const row = await prisma.skillAllocationProfile.findFirst({
    where: { profileCode, isActive: true },
    orderBy: { effectiveFrom: 'desc' },
    select: { listeningPct: true, readingPct: true, speakingPct: true, writingPct: true },
  });
  if (!row) return null;
  const allocation: SkillAllocation = {
    LISTENING: row.listeningPct,
    READING: row.readingPct,
    SPEAKING: row.speakingPct,
    WRITING: row.writingPct,
  };
  // 档案可能被手工改坏（合计≠100）：不拦保存，但绝不拿它去配平
  return checkAllocation(allocation).ok ? allocation : null;
}

const FOUR_SKILLS: AllocationSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];

function isFourSkill(value: string | null | undefined): value is AllocationSkill {
  return FOUR_SKILLS.includes(value as AllocationSkill);
}

/** 到期 / 逾期复习的预估负荷。 */
export interface DueReviewLoad {
  estMinutes: number;
  count: number;
  maxOverdueDays: number;
}

/**
 * 到期 + 逾期复习负荷；没有待复习项时返回 `null`。
 *
 * `estMinutes` 用每条 `ReviewTask.estMinutes` 求和，不用「条数 × 固定分钟」。
 */
export async function getDueReviewLoad(nowDate: string = today()): Promise<DueReviewLoad | null> {
  const rows = await prisma.reviewTask.findMany({
    where: { status: 'PENDING', dueDate: { lte: nowDate } },
    select: { estMinutes: true, dueDate: true },
  });
  if (rows.length === 0) return null;

  let estMinutes = 0;
  let maxOverdueDays = 0;
  for (const row of rows) {
    estMinutes += Math.max(0, row.estMinutes);
    maxOverdueDays = Math.max(maxOverdueDays, diffDays(row.dueDate, nowDate));
  }
  return { estMinutes, count: rows.length, maxOverdueDays };
}

/**
 * 本周四技能偏差（分钟，正数 = 相对阶段配比还欠多少）。
 *
 * 已投入 = 本周各技能的实际净分钟（DaySplit）+ 本周其他日期已排但未做完的计划分钟。
 * 偏差 = 配比 × 四技能合计 − 该技能已投入，四项之和恒为 0。
 *
 * 分母用四技能合计而不是周目标：技能池只占日预算的一部分，拿周目标乘配比
 * 会让每项都显示巨大缺口，小份额技能（如写作 15%）整周都排不到。
 * 把「已排未做」算进来，是为了一次生成多天计划时不会每天都选同一项。
 *
 * 没有配比档案时返回 `null`，不拿 25/25/25/25 硬算。
 */
export async function getWeeklySkillGap(
  planDate: string,
  allocation: SkillAllocation | null,
): Promise<Record<AllocationSkill, number> | null> {
  if (!allocation) return null;

  const { weekStart, weekEnd } = weekRange(planDate);
  const [splits, openTasks] = await Promise.all([
    prisma.studySessionDaySplit.findMany({
      where: { date: { gte: weekStart, lte: weekEnd } },
      select: { minutes: true, session: { select: { skill: true } } },
    }),
    prisma.planTask.findMany({
      where: {
        planDate: { gte: weekStart, lte: weekEnd, not: planDate },
        status: { in: ['TODO', 'IN_PROGRESS'] },
      },
      select: { primarySkill: true, plannedMinutes: true, actualMinutes: true },
    }),
  ]);

  const committed: Record<AllocationSkill, number> = {
    LISTENING: 0,
    READING: 0,
    SPEAKING: 0,
    WRITING: 0,
  };
  for (const split of splits) {
    const skill = split.session?.skill;
    if (isFourSkill(skill)) committed[skill] += split.minutes;
  }
  for (const task of openTasks) {
    if (isFourSkill(task.primarySkill)) {
      committed[task.primarySkill] += Math.max(0, task.plannedMinutes - task.actualMinutes);
    }
  }

  const total = FOUR_SKILLS.reduce((sum, skill) => sum + committed[skill], 0);
  const gap = {} as Record<AllocationSkill, number>;
  for (const skill of FOUR_SKILLS) {
    gap[skill] = (total * allocation[skill]) / 100 - committed[skill];
  }
  return gap;
}

/**
 * 有证据的弱项技能（最多 3 项，正确率由低到高）。
 *
 * 证据口径：近 28 天该技能做题数达到最小样本，且正确率低于四技能合并正确率。
 * 只有一项技能有数据时无从比较，返回空 —— 不凭「练得少」就判定为弱项。
 */
export async function getWeakSkills(planDate: string): Promise<AllocationSkill[]> {
  const records = await prisma.studyRecord.findMany({
    where: {
      archivedAt: null,
      recordDate: { gte: addDays(planDate, -(WEAKNESS_WINDOW_DAYS - 1)), lte: planDate },
      skill: { in: FOUR_SKILLS },
    },
    select: { skill: true, totalQuestions: true, correctQuestions: true },
  });

  const agg = new Map<AllocationSkill, { total: number; correct: number }>();
  let allTotal = 0;
  let allCorrect = 0;
  for (const record of records) {
    if (!isFourSkill(record.skill) || record.totalQuestions <= 0) continue;
    const correct = Math.min(record.correctQuestions, record.totalQuestions);
    const entry = agg.get(record.skill) ?? { total: 0, correct: 0 };
    entry.total += record.totalQuestions;
    entry.correct += correct;
    agg.set(record.skill, entry);
    allTotal += record.totalQuestions;
    allCorrect += correct;
  }
  if (allTotal === 0) return [];

  const overall = allCorrect / allTotal;
  return [...agg.entries()]
    .filter(([, entry]) => entry.total >= WEAKNESS_MIN_QUESTIONS && entry.correct / entry.total < overall)
    .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)
    .slice(0, 3)
    .map(([skill]) => skill);
}

/** 引擎输入里与预算无关的部分（生成与重排共用同一份装配，避免两处口径漂移）。 */
export type PlanEngineContext = Omit<AdaptivePlanInput, 'budgetMinutes' | 'isRestDay' | 'tierCode'>;

/** 装配引擎输入：阶段配比、到期复习、弱项、本周偏差与规划器参数。 */
export async function loadPlanEngineContext(
  planDate: string,
  stage: { id: string; code: string; profileCode: string | null },
): Promise<PlanEngineContext> {
  const [allocation, dueReviews, weakSkills, settings, doneBaselines] = await Promise.all([
    activeAllocationFor(stage.profileCode),
    getDueReviewLoad(planDate),
    getWeakSkills(planDate),
    prisma.plannerSettings.findUnique({ where: { id: 1 } }),
    // S0 的基线诊断每项只做一次：已完成的不再排
    stage.code === 'S0_PREP'
      ? prisma.planTask.findMany({
          where: { stageId: stage.id, module: { in: S0_MODULES }, status: 'DONE' },
          select: { module: true },
          distinct: ['module'],
        })
      : Promise.resolve([]),
  ]);
  const weeklyGap = await getWeeklySkillGap(planDate, allocation);

  let p0CapRatio = P0_CAP_RATIO;
  let coreMinRatio = CORE_MIN_RATIO;
  try {
    const policy = JSON.parse(settings?.priorityPolicy ?? '{}') as Record<string, unknown>;
    if (typeof policy.p0CapRatio === 'number' && policy.p0CapRatio > 0 && policy.p0CapRatio <= 1) {
      p0CapRatio = policy.p0CapRatio;
    }
    if (typeof policy.coreMinRatio === 'number' && policy.coreMinRatio >= 0 && policy.coreMinRatio < 1) {
      coreMinRatio = policy.coreMinRatio;
    }
  } catch {
    // 配置 JSON 损坏：回落到常量默认值
  }

  return {
    stageCode: stage.code as StageCode,
    allocation,
    dueReviews,
    weakSkills,
    weeklyGap,
    minTaskMinutes: settings?.minTaskMinutes ?? MIN_TASK_MINUTES,
    p0CapRatio,
    coreMinRatio,
    skipModules: doneBaselines.map((row) => row.module as ModuleId),
  };
}

/** 该日期下一个可用的计划版本号（同时看版本表与任务行，避免与 v2.0 旧任务的 version=1 相撞）。 */
export async function nextPlanVersion(planDate: string): Promise<number> {
  const [versionMax, taskMax] = await Promise.all([
    prisma.planVersion.aggregate({ where: { planDate }, _max: { version: true } }),
    prisma.planTask.aggregate({ where: { planDate }, _max: { planVersion: true } }),
  ]);
  return Math.max(versionMax._max.version ?? 0, taskMax._max.planVersion ?? 0) + 1;
}
