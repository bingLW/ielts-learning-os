/**
 * 资源库 zod 契约。资源名本身不在这里出现 —— 8 类初始资源由 seed 写库，
 * 代码只认识「科目 / 类型」这类结构枚举。
 */

import { z } from 'zod';
import { RESOURCE_SUBJECTS, RESOURCE_TYPES, STAGE_CODES } from '../constants';
import { dateString, enumFrom, optionalText } from './common';

export const upsertResourceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, '请填写资源名称').max(120, '名称不超过 120 字'),
  subject: enumFrom(RESOURCE_SUBJECTS, '科目'),
  type: enumFrom(RESOURCE_TYPES, '类型'),
  applicableStages: z.array(enumFrom(STAGE_CODES, '适用阶段')).min(1, '至少选择一个适用阶段'),
  version: optionalText(60),
  totalUnits: z.coerce.number().int().min(0).max(10000).optional(),
  currentUnit: z.coerce.number().int().min(0).max(10000).optional(),
  startDate: z.union([dateString, z.literal('')]).optional(),
  finishDate: z.union([dateString, z.literal('')]).optional(),
  url: z.union([z.string().url('链接格式不合法'), z.literal('')]).optional(),
  note: optionalText(500),
  isPrimary: z.boolean().optional(),
});
export type UpsertResourceInput = z.infer<typeof upsertResourceSchema>;

export const archiveResourceSchema = z.object({
  id: z.string().min(1, '缺少资源 ID'),
});
export type ArchiveResourceInput = z.infer<typeof archiveResourceSchema>;
