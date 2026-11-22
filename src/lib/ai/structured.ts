/**
 * 结构化输出协议（v2.4 需求第 4 节）。
 *
 * 所有 AI 输出先经过这里的 zod 校验，校验失败不落库；
 * 字段名保持 snake_case，与需求文档一致。
 */

import { z } from 'zod';
import {
  AI_ACCEPTED_AIDS,
  AI_EVIDENCE_AID_LEVELS,
  AI_EVIDENCE_PERFORMANCE_TYPES,
  AI_ERROR_CATEGORIES,
  AI_TASK_SKILLS,
} from '@/lib/constants';
import { enumFrom } from '@/lib/schema/common';
import type { AiPromptKind } from './types';

const confidenceSchema = enumFrom(['LOW', 'MEDIUM', 'HIGH'] as const, '置信度');
const stringList = (max: number, itemMax = 300) =>
  z.array(z.string().min(1).max(itemMax)).max(max);

export const taskSpecSchema = z.object({
  task_id: z.string().min(1).max(80),
  skill: enumFrom(AI_TASK_SKILLS, '技能'),
  target_level: z.string().min(1).max(20),
  objective: z.string().min(1).max(500),
  instructions: z.string().min(1).max(2000),
  estimated_minutes: z.number().int().min(1).max(120),
  allowed_aids: z.array(enumFrom(AI_ACCEPTED_AIDS, '辅助工具')).max(4),
  rubric: z
    .array(
      z.object({
        criterion: z.string().min(1).max(80),
        description: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(6),
  source_refs: stringList(5, 200).optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const diagnosisResultSchema = z
  .object({
    summary: z.string().min(1).max(800),
    observed_evidence: z
      .array(
        z.object({
          quote: z.string().max(400),
          location: z.string().max(120).optional(),
        }),
      )
      .max(6),
    error_categories: z.array(enumFrom(AI_ERROR_CATEGORIES, '错误分类')).max(4),
    hypotheses: z
      .array(
        z.object({
          cause: z.string().min(1).max(200),
          confidence: confidenceSchema,
          basis: z.string().max(300).optional(),
        }),
      )
      .max(5),
    confirmed_vs_uncertain: z.string().min(1).max(500),
    strengths: stringList(5),
    priority_issues: stringList(5),
    recommended_next_step: z.string().min(1).max(300),
  })
  .superRefine((value, ctx) => {
    const hasQuote = value.observed_evidence.some((item) => item.quote.trim().length > 0);
    if (!hasQuote && !value.summary.includes('证据不足')) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed_evidence'],
        message: '诊断必须引用具体作答片段，或在 summary 中明确标注「证据不足」',
      });
    }
  });
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

export const hintResultSchema = z
  .object({
    hint_level: z.number().int().min(1).max(3),
    hint_text: z.string().min(1).max(600),
    reveals_answer: z.boolean(),
    related_rule: z.string().max(200).optional(),
    next_question: z.string().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.hint_level < 3 && value.reveals_answer) {
      ctx.addIssue({
        code: 'custom',
        path: ['reveals_answer'],
        message: '1–2 级提示不得直接泄露答案',
      });
    }
  });
export type HintResult = z.infer<typeof hintResultSchema>;

export const feedbackResultSchema = z.object({
  what_went_well: stringList(4),
  what_to_improve: stringList(4),
  specific_corrections: z
    .array(
      z.object({
        original: z.string().min(1).max(300),
        corrected: z.string().min(1).max(300),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(6),
  explanation: z.string().min(1).max(1200),
  practice_recommendations: stringList(5),
  limitations: z.string().max(400),
});
export type FeedbackResult = z.infer<typeof feedbackResultSchema>;

export const drillSetSchema = z.object({
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(300),
  items: z
    .array(
      z.object({
        prompt: z.string().min(1).max(600),
        answer: z.string().min(1).max(600),
        explanation: z.string().min(1).max(600),
        difficulty: enumFrom(['EASY', 'MEDIUM', 'HARD'] as const, '难度').optional(),
      }),
    )
    .min(1)
    .max(6),
  estimated_minutes: z.number().int().min(1).max(60),
});
export type DrillSet = z.infer<typeof drillSetSchema>;

export const evidenceAssessmentSchema = z.object({
  performance_type: enumFrom(AI_EVIDENCE_PERFORMANCE_TYPES, '表现类型'),
  aid_level: enumFrom(AI_EVIDENCE_AID_LEVELS, '辅助等级'),
  rubric_scores: z
    .array(
      z.object({
        criterion: z.string().min(1).max(80),
        score: z.number().int().min(0).max(2),
        comment: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(6),
  evidence_refs: stringList(8, 200),
  confidence: confidenceSchema,
  is_official_score: z.literal(false),
  limitations: z.string().min(1).max(400),
});
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;

export const reviewerResultSchema = z.object({
  summary: z.string().min(1).max(800),
  comparison: z.object({
    improved: stringList(5),
    still_weak: stringList(5),
  }),
  retest_task: z.object({
    instructions: z.string().min(1).max(800),
    estimated_minutes: z.number().int().min(1).max(60),
  }),
  next_step: z.string().min(1).max(300),
  confidence: confidenceSchema,
});
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;

export const SCHEMA_BY_KIND = {
  task: taskSpecSchema,
  diagnosis: diagnosisResultSchema,
  hint: hintResultSchema,
  teaching: feedbackResultSchema,
  drill: drillSetSchema,
  assessment: evidenceAssessmentSchema,
  reviewer: reviewerResultSchema,
} as const;

export type StructuredByKind = {
  task: TaskSpec;
  diagnosis: DiagnosisResult;
  hint: HintResult;
  teaching: FeedbackResult;
  drill: DrillSet;
  assessment: EvidenceAssessment;
  reviewer: ReviewerResult;
};

export type StructuredParseResult<K extends AiPromptKind> =
  | { ok: true; data: StructuredByKind[K] }
  | { ok: false; error: string };

export function parseStructured<K extends AiPromptKind>(
  kind: K,
  input: unknown,
): StructuredParseResult<K> {
  const result = SCHEMA_BY_KIND[kind].safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data as StructuredByKind[K] };
  }
  const first = result.error.issues[0];
  const path = first.path.join('.') || '(根)';
  return { ok: false, error: `AI 输出不符合 ${kind} 协议：${path} ${first.message}` };
}