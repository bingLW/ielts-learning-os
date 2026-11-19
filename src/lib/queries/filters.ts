/**
 * 全局筛选（T32）。
 *
 * 原则：筛选态**只存在于 URL**（searchParams），服务端读取并下推到 Prisma `where`；
 * 客户端不持有筛选状态，也不做二次过滤 —— 这样刷新、分享、书签都得到同一结果。
 */

import {
  ANALYTICS_WINDOW_DAYS,
  GLOBAL_FILTER_KEYS,
  SKILL_IDS,
  SKILL_LABEL_ZH,
  STAGE_CODES,
  STAGE_META,
} from '@/lib/constants';
import { addDays, isValidDateString, today } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import type {
  FilterOptionDto,
  GlobalFilterDto,
  GlobalFilterKey,
  GlobalFilterOptionsDto,
  SkillId,
} from '@/lib/types';

/** Next 的 searchParams 形态（值可能是数组）。 */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** 取单值。 */
export function firstParam(params: RawSearchParams, key: GlobalFilterKey): string | null {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** 解析筛选态；任何非法值都退回默认值，绝不抛错。 */
export function parseGlobalFilter(
  params: RawSearchParams,
  nowDate: string = today(),
): GlobalFilterDto {
  const defaultTo = nowDate;
  const defaultFrom = addDays(nowDate, -(ANALYTICS_WINDOW_DAYS - 1));

  const rawFrom = firstParam(params, 'from');
  const rawTo = firstParam(params, 'to');
  let from = rawFrom && isValidDateString(rawFrom) ? rawFrom : defaultFrom;
  let to = rawTo && isValidDateString(rawTo) ? rawTo : defaultTo;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  const rawStage = firstParam(params, 'stageId');
  const rawSkill = firstParam(params, 'skill');
  const rawResource = firstParam(params, 'resourceId');

  const skill = rawSkill && (SKILL_IDS as readonly string[]).includes(rawSkill)
    ? (rawSkill as SkillId)
    : null;

  return {
    from,
    to,
    stageId: rawStage && rawStage.trim().length > 0 ? rawStage : null,
    skill,
    resourceId: rawResource && rawResource.trim().length > 0 ? rawResource : null,
  };
}

/** 筛选下拉选项（阶段 / 科目来自常量，资源来自数据库）。 */
export async function getGlobalFilterOptions(): Promise<GlobalFilterOptionsDto> {
  const [stages, resources] = await Promise.all([
    prisma.stage.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, code: true } }),
    prisma.resource.findMany({
      where: { archivedAt: null },
      orderBy: [{ subject: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  const stageOptions: FilterOptionDto[] = stages.map((stage) => ({
    value: stage.id,
    label: STAGE_META[stage.code as keyof typeof STAGE_META]?.nameZh ?? stage.code,
  }));

  const skillOptions: FilterOptionDto[] = SKILL_IDS.map((skill) => ({
    value: skill,
    label: SKILL_LABEL_ZH[skill],
  }));

  const resourceOptions: FilterOptionDto[] = resources.map((resource) => ({
    value: resource.id,
    label: resource.name,
  }));

  return { stages: stageOptions, skills: skillOptions, resources: resourceOptions };
}

/** 把筛选态写回 query string（页面内部跳转用；空值不落 URL）。 */
export function buildFilterQuery(filter: Partial<GlobalFilterDto>): string {
  const params = new URLSearchParams();
  for (const key of GLOBAL_FILTER_KEYS) {
    const value = filter[key];
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** 筛选项是否全部为默认值（用于显示「未筛选」提示）。 */
export function isDefaultFilter(filter: GlobalFilterDto, nowDate: string = today()): boolean {
  return (
    filter.stageId === null &&
    filter.skill === null &&
    filter.resourceId === null &&
    filter.to === nowDate &&
    filter.from === addDays(nowDate, -(ANALYTICS_WINDOW_DAYS - 1))
  );
}

/** 阶段编码下拉（资源表单之类只需 code 的地方）。 */
export function stageCodeOptions(): FilterOptionDto[] {
  return STAGE_CODES.map((code) => ({ value: code, label: STAGE_META[code].nameZh }));
}
