/**
 * 方法论资料库的 zod 契约。
 *
 * 只允许写「个人摘要 / 实践计划 / 关联证据」——不存在正文入库字段。
 */

import { z } from 'zod';
import { RESOURCE_READ_STATUSES } from '../constants';
import { enumFrom, optionalId, optionalText } from './common';

/** 更新一条资料的阅读日志（每资源一行，可反复更新）。 */
export const updateReadingLogSchema = z.object({
  resourceId: z.string().min(1, '缺少资料 ID'),
  status: enumFrom(RESOURCE_READ_STATUSES, '阅读状态'),
  personalSummary: optionalText(2000),
  plannedAction: optionalText(500),
  appliedEvidenceId: optionalId,
});

export type UpdateReadingLogInput = z.infer<typeof updateReadingLogSchema>;
