/**
 * v2.6 材料导入的输入校验（`src/lib/schema/material.ts`）。
 *
 * 硬约束（PRD §3.1 / A-01）：**必须**显式勾选「我确认有权使用」，
 * 且 `open_license` 必须填许可名称、`user_provided_url` 必须填链接 ——
 * 这些是产品承诺，不是提示文案，因此放在 schema 层拦截，Action 层不得绕过。
 */

import { z } from 'zod';
import {
  MATERIAL_FORMATS,
  MATERIAL_JOB_STAGES,
  MATERIAL_LIMITS,
  MATERIAL_OFFICIAL_SKILLS,
  MATERIAL_SOURCE_TYPES,
} from '@/lib/constants';
import { enumFrom, optionalText } from './common';

/** 来源登记（PRD §3.1 七类来源）。 */
export const materialSourceSchema = z
  .object({
    sourceType: enumFrom(MATERIAL_SOURCE_TYPES, '来源类型'),
    url: optionalText(2048),
    author: optionalText(200),
    publisher: optionalText(200),
    publishedYear: z.coerce.number().int().min(1000).max(2100).optional(),
    licenseName: optionalText(200),
    licenseUrl: optionalText(2048),
    userNote: optionalText(1000),
    /** 必须为 true —— 禁止预设勾选（A-01）。 */
    rightsConfirmed: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (!value.rightsConfirmed) {
      ctx.addIssue({
        code: 'custom',
        path: ['rightsConfirmed'],
        message: '必须确认你对该材料有使用权限',
      });
    }
    if (value.sourceType === 'open_license' && !value.licenseName) {
      ctx.addIssue({
        code: 'custom',
        path: ['licenseName'],
        message: '开放许可必须填写许可名称',
      });
    }
    if (value.sourceType === 'user_provided_url' && !value.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: '请填写链接，或改用「粘贴摘录」',
      });
    }
    if (value.licenseUrl && !/^https?:\/\//i.test(value.licenseUrl)) {
      ctx.addIssue({
        code: 'custom',
        path: ['licenseUrl'],
        message: '许可链接必须以 http(s):// 开头',
      });
    }
    if (value.url && !/^https?:\/\//i.test(value.url)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: '链接必须以 http(s):// 开头' });
    }
  });

export type MaterialSourceInput = z.infer<typeof materialSourceSchema>;

/**
 * 上传表单里的 `meta` 字段（JSON 字符串）。
 *
 * 注意：`format` **不由客户端决定**——服务端按文件扩展名 + 魔数嗅探得出，
 * 这里保留 `declaredFormat` 仅用于「前端预期」对照（如不一致只做日志，不采信）。
 */
export const materialUploadMetaSchema = z.object({
  title: optionalText(200),
  language: optionalText(20),
  targetSkills: z.array(enumFrom(MATERIAL_OFFICIAL_SKILLS, '目标技能')).max(4).optional(),
  /** 粘贴摘录的正文（与 file 二选一）。 */
  pastedText: optionalText(200_000),
  /** 前端以为的格式；服务端不采信，仅作对照。 */
  declaredFormat: z
    .string()
    .refine(
      (value) => (MATERIAL_FORMATS as readonly string[]).includes(value),
      '格式取值不合法',
    )
    .optional(),
  source: materialSourceSchema,
});

export type MaterialUploadMeta = z.infer<typeof materialUploadMetaSchema>;

// ─────────────────── T08：材料库 / 导入向导 / 重试 / 删除 的输入校验 ───────────────────

/** 材料 id（本地生成器 `createLocalId` 与 cuid 都满足 `[A-Za-z0-9_-]{6,64}`）。 */
export const materialIdSchema = z.object({
  materialId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,64}$/, '材料 id 不合法'),
});

/**
 * 粘贴摘录导入。
 *
 * 与上传通道的 `pastedText` 同一口径（≤200k 字符），但这里是**独立入口**：
 * 用户在导入向导第 1 步选「粘贴一段文本」时走 Server Action，不必构造 FormData。
 */
export const materialPastedExcerptSchema = z.object({
  title: optionalText(200),
  language: optionalText(20),
  targetSkills: z.array(enumFrom(MATERIAL_OFFICIAL_SKILLS, '目标技能')).max(4).optional(),
  text: z
    .string()
    .trim()
    .min(1, '请粘贴一段文本')
    .max(MATERIAL_LIMITS.maxPastedChars, `粘贴内容不能超过 ${MATERIAL_LIMITS.maxPastedChars} 字符`),
  source: materialSourceSchema,
});

export type MaterialPastedExcerptInput = z.infer<typeof materialPastedExcerptSchema>;

/** 重试（A-08）：可指定从哪个阶段续跑，缺省按是否已有解析结果自动判断。 */
export const materialRetrySchema = materialIdSchema.extend({
  fromStage: enumFrom(MATERIAL_JOB_STAGES, '阶段').optional(),
});

/** 删除材料：必须手打 `DELETE`（破坏性操作二次确认，G-01）。 */
export const materialDeleteSchema = materialIdSchema.extend({
  confirmText: z.string().refine((value) => value === 'DELETE', '请输入 DELETE 以确认删除'),
});

/** 去重命中后的二选一（A-04）。 */
export const MATERIAL_DUPLICATE_CHOICES = ['open_existing', 'keep_copy'] as const;
export type MaterialDuplicateChoice = (typeof MATERIAL_DUPLICATE_CHOICES)[number];

export const materialDuplicateChoiceSchema = materialIdSchema.extend({
  choice: enumFrom(MATERIAL_DUPLICATE_CHOICES, '选择'),
});

/**
 * 音频材料登记（P1 降级：只登记不转写）。
 *
 * `audioAssetId` 指向既有 `AudioAsset`（v2.5 已支持上传）；本批不引入转写，
 * 因此只落 `MaterialAsset(kind='AUDIO_REF')` + `status='created'`（`statusReason` 写明待转写）。
 */
export const materialAudioMetaSchema = z.object({
  title: optionalText(200),
  language: optionalText(20),
  audioAssetId: z.string().min(1, '请选择已上传的音频'),
  durationSec: z.coerce.number().int().min(0).max(60 * 60 * 12).optional(),
  source: materialSourceSchema,
});

export type MaterialAudioMetaInput = z.infer<typeof materialAudioMetaSchema>;
