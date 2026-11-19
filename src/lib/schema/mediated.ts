/**
 * 英语媒介学习（English-mediated Learning）的 zod 契约。
 *
 * 一次记录 = 一条 `EnglishMediatedSession` + 一条 `StudySession`（track/skill/mediatedId
 * 快照）+ 跨零点 `DaySplit` + 若干 `LearningOutput`。
 *
 * 硬约束：
 * 1. 时长必须 > 0（净时长唯一来源是落库的 `StudySession`，`durationMinutes` 只做表内自洽）；
 * 2. 「英文产出」至少一项（笔记 / 摘要 / 问题），否则不构成可检查的学习证据；
 * 3. `primarySkill` 必须是四技能之一（媒介学习是跨技能应用，不是第五技能）。
 */

import { z } from 'zod';
import {
  MEDIATED_INTENSITIES,
  MEDIATED_UNDERSTANDINGS,
  PRIMARY_SKILLS,
  SOURCE_TYPES,
  TRANSLATION_DEPENDENCIES,
} from '../constants';
import { dateString, enumFrom, minutesField, optionalId, optionalText } from './common';

/** 语言难度自评：A2/B1/B2/C1。 */
const languageLevel = z
  .string()
  .regex(/^(A2|B1|B2|C1)$/, '语言难度自评取值不合法')
  .optional();

/** 新建媒介学习记录。 */
export const createMediatedSessionSchema = z
  .object({
    sessionDate: dateString,
    /** 所学学科，默认 French。 */
    subject: z.string().trim().min(1, '请填写学科').max(40, '学科不超过 40 字'),
    /** 具体主题（如 French present tense）。 */
    topic: z.string().trim().min(1, '请填写主题').max(120, '主题不超过 120 字'),
    sourceTitle: optionalText(200),
    sourceUrl: optionalText(500),
    sourceType: enumFrom(SOURCE_TYPES, '材料类型'),
    primarySkill: enumFrom(PRIMARY_SKILLS, '主要技能'),
    /** 记录时长（分钟）；真值以落库 StudySession 为准。 */
    durationMinutes: minutesField(1, 600),
    languageLevel,
    understanding: enumFrom(MEDIATED_UNDERSTANDINGS, '理解情况'),
    translationDependency: enumFrom(TRANSLATION_DEPENDENCIES, '翻译依赖'),
    notesEn: optionalText(6000),
    summaryEn: optionalText(6000),
    questionsEn: optionalText(6000),
    intensity: enumFrom(MEDIATED_INTENSITIES, '强度档'),
    note: optionalText(1000),
    /** 已存在的关联资源（可选）。 */
    resourceId: optionalId,
  })
  .refine(
    (value) =>
      (value.notesEn ?? '').trim().length > 0 ||
      (value.summaryEn ?? '').trim().length > 0 ||
      (value.questionsEn ?? '').trim().length > 0,
    {
      message: '英文笔记、摘要、问题至少填一项（每次媒介学习必须留下可检查的英文产出）',
      path: ['notesEn'],
    },
  );

export type CreateMediatedSessionInput = z.infer<typeof createMediatedSessionSchema>;
