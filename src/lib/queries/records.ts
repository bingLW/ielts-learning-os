/**
 * 学习记录只读查询。
 *
 * 全部返回手写 DTO —— Prisma 原始 model 不出 Server（`Date` / `Decimal` 无法直接
 * 传给 Client Component，`accuracy` 也不落库）。
 */

import { PAGE_SIZE, SKILL_LABEL_ZH } from '@/lib/constants';
import { accuracyOf } from '@/lib/domain/accuracy';
import { parseObject, parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  Difficulty,
  LearningTrack,
  PrimarySkill,
  RevisionRowDto,
  SkillId,
  StudyRecordDetailDto,
  StudyRecordRowDto,
  TaskStatus,
} from '@/lib/types';

/** 修订历史里字段名的中文标签（Prisma 字段 → 用户可读名）。 */
export const REVISION_FIELD_LABEL_ZH: Record<string, string> = {
  recordDate: '日期',
  skill: '科目',
  resourceId: '资源',
  chapter: '章节/单元',
  content: '内容摘要',
  plannedMinutes: '计划时长',
  actualMinutes: '实际时长',
  status: '状态',
  totalQuestions: '总题数',
  correctQuestions: '正确数',
  difficulty: '难度',
  outputText: '产出',
  problemText: '问题',
  errorTypes: '错误类型',
  nextReviewDate: '下次复习日期',
  ext: '分科扩展',
};

export interface RecordListFilters {
  skill?: string;
  stageId?: string;
  resourceId?: string;
  fromDate?: string;
  toDate?: string;
}

/** 记录列表（按日期倒序，默认取最近 50 条）。 */
export async function listRecords(
  filters: RecordListFilters = {},
  limit = PAGE_SIZE,
): Promise<StudyRecordRowDto[]> {
  const where: Record<string, unknown> = { archivedAt: null };
  if (filters.skill) where.skill = filters.skill;
  if (filters.stageId) where.stageId = filters.stageId;
  if (filters.resourceId) where.resourceId = filters.resourceId;
  if (filters.fromDate || filters.toDate) {
    const range: Record<string, string> = {};
    if (filters.fromDate) range.gte = filters.fromDate;
    if (filters.toDate) range.lte = filters.toDate;
    where.recordDate = range;
  }

  const rows = await prisma.studyRecord.findMany({
    where,
    orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    include: { resource: { select: { name: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    recordDate: row.recordDate,
    skill: row.skill as SkillId,
    skillLabel: SKILL_LABEL_ZH[row.skill as SkillId] ?? row.skill,
    track: row.track as LearningTrack,
    primarySkill: row.primarySkill as PrimarySkill,
    content: row.content,
    chapter: row.chapter,
    resourceName: row.resource?.name ?? null,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    totalQuestions: row.totalQuestions,
    correctQuestions: row.correctQuestions,
    accuracy: accuracyOf(row.correctQuestions, row.totalQuestions),
    status: row.status as TaskStatus,
    difficulty: (row.difficulty as Difficulty) ?? null,
    hasOutput:
      (row.outputText ?? '').trim().length > 0 || (row.problemText ?? '').trim().length > 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** 记录详情（编辑表单回填）。 */
export async function getRecordDetail(id: string): Promise<StudyRecordDetailDto | null> {
  const row = await prisma.studyRecord.findUnique({
    where: { id },
    include: { resource: { select: { name: true } } },
  });
  if (!row || row.archivedAt) return null;

  return {
    id: row.id,
    stageId: row.stageId,
    taskId: row.taskId,
    resourceId: row.resourceId,
    recordDate: row.recordDate,
    skill: row.skill as SkillId,
    skillLabel: SKILL_LABEL_ZH[row.skill as SkillId] ?? row.skill,
    track: row.track as LearningTrack,
    primarySkill: row.primarySkill as PrimarySkill,
    content: row.content,
    chapter: row.chapter,
    resourceName: row.resource?.name ?? null,
    plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes,
    totalQuestions: row.totalQuestions,
    correctQuestions: row.correctQuestions,
    accuracy: accuracyOf(row.correctQuestions, row.totalQuestions),
    status: row.status as TaskStatus,
    difficulty: (row.difficulty as Difficulty) ?? null,
    outputText: row.outputText,
    problemText: row.problemText,
    errorTypes: parseStringArray(row.errorTypes),
    nextReviewDate: row.nextReviewDate,
    ext: parseObject<Record<string, unknown>>(row.ext, {}),
    hasOutput:
      (row.outputText ?? '').trim().length > 0 || (row.problemText ?? '').trim().length > 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 最近 10 次字段级修订（P1-03）。 */
export async function listRevisions(recordId: string, take = 10): Promise<RevisionRowDto[]> {
  const rows = await prisma.recordRevision.findMany({
    where: { recordId },
    orderBy: { changedAt: 'desc' },
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    field: row.field,
    fieldLabel: REVISION_FIELD_LABEL_ZH[row.field] ?? row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt.toISOString(),
  }));
}

/** 记录条数（列表页副标题）。 */
export async function countRecords(filters: RecordListFilters = {}): Promise<number> {
  const where: Record<string, unknown> = { archivedAt: null };
  if (filters.skill) where.skill = filters.skill;
  if (filters.stageId) where.stageId = filters.stageId;
  return prisma.studyRecord.count({ where });
}
