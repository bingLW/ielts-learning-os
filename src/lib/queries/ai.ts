/**
 * AI 建议查询（P5：规则引擎建议，不再是「预留」）。
 *
 * 分两层：
 * - 数据源聚合（本文件）：从数据库取真实数据，交给领域层；
 * - 建议生成（`domain/suggestion.ts`）：纯函数，确定性、带 basis。
 */

import { AI_SCOPE_LABEL_ZH, AI_SCOPES, AI_STATUS_LABEL_ZH } from '@/lib/constants';
import { addDays, today } from '@/lib/date';
import { accumulatePrimaryMinutes, defaultAllocationFor } from '@/lib/domain/allocation';
import { prisma } from '@/lib/prisma';
import type { AiScope, AiSuggestionDto, SkillAllocation, StageProfileCode } from '@/lib/types';
import { getActiveStage } from './stages';
import { currentIsoWeek, getWeeklyRawInput, isoWeekStart } from './weekly';
import { getWeaknessRanking } from './weakness';

/** 单条 → DTO。 */
function toDto(row: {
  id: string;
  scope: string;
  refKey: string | null;
  status: string;
  title: string;
  body: string;
  basis: string | null;
  provider: string | null;
  createdAt: Date;
}): AiSuggestionDto {
  const scope = row.scope as AiScope;
  return {
    id: row.id,
    scope,
    scopeLabel: AI_SCOPE_LABEL_ZH[scope] ?? row.scope,
    refKey: row.refKey,
    status: row.status,
    statusLabel: AI_STATUS_LABEL_ZH[row.status] ?? row.status,
    title: row.title,
    body: row.body,
    basis: row.basis,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 按作用域列建议（默认薄弱项分析）。 */
export async function listAiSuggestions(scope: AiScope = 'WEAKNESS', limit = 5): Promise<AiSuggestionDto[]> {
  const rows = await prisma.aiSuggestion.findMany({
    where: { scope },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(toDto);
}

/** 所有作用域的最新建议（设置页展示用）。 */
export async function listAllAiSuggestions(limit = 10): Promise<AiSuggestionDto[]> {
  const rows = await prisma.aiSuggestion.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(toDto);
}

/** 每个作用域各取最新一条 + 是否已开放（`UserProfile.aiEnabled`）。 */
export async function getAiPanel(): Promise<{
  enabled: boolean;
  scopes: { scope: AiScope; label: string; latest: AiSuggestionDto | null }[];
}> {
  const [profile, rows] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: 1 } }),
    prisma.aiSuggestion.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);

  const latestByScope = new Map<string, AiSuggestionDto>();
  for (const row of rows) {
    if (!latestByScope.has(row.scope)) latestByScope.set(row.scope, toDto(row));
  }

  return {
    enabled: profile?.aiEnabled ?? false,
    scopes: AI_SCOPES.map((scope) => ({
      scope,
      label: AI_SCOPE_LABEL_ZH[scope],
      latest: latestByScope.get(scope) ?? null,
    })),
  };
}

// ───────────────────────── P5：数据源聚合 ─────────────────────────

/** 本周四技能净时长 + 阶段建议配比（供「计划建议」scope）。 */
export async function getPlanAllocationSnapshot(nowDate: string = today()): Promise<{
  minutes: ReturnType<typeof accumulatePrimaryMinutes>;
  target: SkillAllocation | null;
}> {
  const { isoYear, isoWeek } = currentIsoWeek(nowDate);
  const weekStart = isoWeekStart(isoYear, isoWeek);
  const weekEnd = addDays(weekStart, 6);

  const [splitRows, stage] = await Promise.all([
    prisma.studySessionDaySplit.findMany({
      where: { date: { gte: weekStart, lte: weekEnd } },
      select: { minutes: true, session: { select: { skill: true } } },
    }),
    getActiveStage(),
  ]);

  const minutes = accumulatePrimaryMinutes(
    splitRows.map((row) => ({ skill: row.session.skill, minutes: row.minutes })),
  );

  const target = stage?.profileCode
    ? defaultAllocationFor(stage.profileCode as StageProfileCode)
    : null;

  return { minutes, target };
}

/** 本周周报原始输入（供「周报建议」scope）。 */
export async function getWeeklySuggestionInput(nowDate: string = today()) {
  const { isoYear, isoWeek } = currentIsoWeek(nowDate);
  const weekStart = isoWeekStart(isoYear, isoWeek);
  const weekEnd = addDays(weekStart, 6);
  return getWeeklyRawInput(weekStart, weekEnd, nowDate);
}

/** 弱项排序（供「弱项分析」scope）。 */
export async function getWeaknessSuggestionInput(nowDate: string = today()) {
  return getWeaknessRanking(nowDate);
}
