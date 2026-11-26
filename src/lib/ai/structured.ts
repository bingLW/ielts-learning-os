/**
 * 结构化输出协议（v2.4 需求第 4 节）。
 *
 * 所有 AI 输出先经过这里的 zod 校验，校验失败不落库；
 * 字段名保持 snake_case，与需求文档一致。
 */

import { z } from 'zod';
import {
  AI_ACCEPTED_AIDS,
  AI_CEFR_LEVELS,
  AI_EVIDENCE_AID_LEVELS,
  AI_EVIDENCE_PERFORMANCE_TYPES,
  AI_ERROR_CATEGORIES,
  AI_TASK_SKILLS,
  MATERIAL_EXERCISE_SKILLS,
  MATERIAL_EXERCISE_TYPES,
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

// ── v2.4.1 诊断域结构化协议 ──────────────────────────────────────────

const diagLevelSchema = enumFrom(
  ['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1'] as const,
  'CEFR 估计等级',
);

const diagDimensionSchema = z.object({
  criterion: z.string().min(1).max(60),
  score: z.number().int().min(0).max(2),
  evidence: z.string().max(300),
  comment: z.string().max(300).optional(),
});

const diagEvaluationSchema = z
  .object({
    estimated_level: diagLevelSchema,
    level_range: z.tuple([diagLevelSchema, diagLevelSchema]),
    dimensions: z.array(diagDimensionSchema).min(1).max(8),
    strengths: stringList(5),
    issues: stringList(5),
    confidence: confidenceSchema,
    limitations: z.string().min(1).max(400),
    needs_follow_up: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const order = ['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1'];
    if (order.indexOf(value.level_range[0]) > order.indexOf(value.level_range[1])) {
      ctx.addIssue({
        code: 'custom',
        path: ['level_range'],
        message: '等级范围下限不能高于上限',
      });
    }
    if (!value.estimated_level) {
      ctx.addIssue({ code: 'custom', path: ['estimated_level'], message: '缺少等级估计' });
    }
  });
export type DiagnosticEvaluation = z.infer<typeof diagEvaluationSchema>;

export const diagRoutingSchema = z.object({
  next_skill: z.string().min(1).max(40),
  next_difficulty: z.number().int().min(1).max(4),
  rationale: z.string().min(1).max(400),
  stop_reason: z.string().max(200).optional(),
});
export type DiagnosticRouting = z.infer<typeof diagRoutingSchema>;

export const diagErrorSchema = z.object({
  categories: stringList(4, 80),
  evidence: stringList(5, 200),
  confidence: confidenceSchema,
});
export type DiagnosticError = z.infer<typeof diagErrorSchema>;

export const diagSummarySchema = z.object({
  summary: z.string().min(1).max(1200),
  strengths: stringList(6),
  gaps: stringList(6),
  suggestions: stringList(6),
  confidence: confidenceSchema,
  limitations: z.string().max(500),
});
export type DiagnosticSummary = z.infer<typeof diagSummarySchema>;

export const diagPlanSchema = z.object({
  rationale: z.string().min(1).max(1000),
  phases: z
    .array(
      z.object({
        window: enumFrom(['7D', '30D', '90D'] as const, '计划窗口'),
        focus: z.string().min(1).max(200),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(120),
              minutes: z.number().int().min(5).max(240),
              evidenceRef: z.string().max(200).optional(),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .length(3),
});
export type DiagnosticPlan = z.infer<typeof diagPlanSchema>;

// ── v2.6 材料域结构化协议（ADR-04 L3：全部 .strict()，不含任何自由文本控制字段） ──

/**
 * 抽取项允许的 kind。
 *
 * `SUMMARY` / `TOPIC` 由 `material_summary` 单独产出，不在这里出现，
 * 避免同一份内容被两种 prompt 重复写进 ExtractionResult。
 */
const MATERIAL_EXTRACT_ITEM_KINDS = [
  'KEYWORD',
  'COLLOCATION',
  'KEY_SENTENCE',
  'PARAGRAPH_GIST',
  'GRAMMAR_POINT',
] as const;

const chunkSeqSchema = z.number().int().min(1).max(100_000);
/** 原文引用：上限 400（ADR-04 L3），下限 1 —— 空引用不允许入库。 */
const sourceQuoteSchema = z.string().min(1).max(400);

const materialExtractItemSchema = z
  .object({
    kind: enumFrom(MATERIAL_EXTRACT_ITEM_KINDS, '抽取类型'),
    source_chunk_seq: chunkSeqSchema,
    source_quote: sourceQuoteSchema,
    /** 词元（≤60）。只有 KEYWORD / COLLOCATION 需要。 */
    lemma: z.string().min(1).max(60).optional(),
    /** 词性（空格串 = 未知，沿用主库约定）。 */
    pos: z.string().max(20).optional(),
    definition_zh: z.string().max(200).optional(),
    collocations: z.array(z.string().min(1).max(80)).max(6).optional(),
    /** 句子主干（AI 推断，C-04 必须标注为推断）。 */
    skeleton: z.string().max(300).optional(),
    grammar_points: z.array(z.string().min(1).max(60)).max(6).optional(),
    /** 段落主旨。 */
    gist: z.string().max(300).optional(),
  })
  .strict();

export const materialExtractSchema = z
  .object({
    items: z.array(materialExtractItemSchema).min(1).max(24),
    batch_note: z.string().max(300).optional(),
  })
  .strict();
export type MaterialExtractResult = z.infer<typeof materialExtractSchema>;
export type MaterialExtractItem = z.infer<typeof materialExtractItemSchema>;

const materialKeyPointSchema = z
  .object({
    text: z.string().min(1).max(300),
    source_chunk_seq: chunkSeqSchema,
    source_quote: sourceQuoteSchema,
  })
  .strict();

export const materialSummarySchema = z
  .object({
    summary_zh: z.string().min(1).max(800),
    summary_en: z.string().max(800).optional(),
    key_points: z.array(materialKeyPointSchema).min(1).max(8),
    topics: z.array(z.string().min(1).max(120)).max(8),
    learning_goals: z.array(z.string().min(1).max(120)).max(8),
  })
  .strict();
export type MaterialSummaryResult = z.infer<typeof materialSummarySchema>;
export type MaterialKeyPoint = z.infer<typeof materialKeyPointSchema>;

const materialExerciseOptionSchema = z
  .object({
    key: z.string().min(1).max(8),
    text: z.string().min(1).max(300),
  })
  .strict();

const materialExerciseItemSchema = z
  .object({
    type: enumFrom(MATERIAL_EXERCISE_TYPES, '题型'),
    target_skill: enumFrom(MATERIAL_EXERCISE_SKILLS, '技能'),
    subskill: z.string().max(60).optional(),
    /** A0–C1，AI 辅助估计（界面必须标注，不得声称官方等级）。 */
    difficulty: enumFrom(AI_CEFR_LEVELS, '难度估计').optional(),
    prompt: z.string().min(1).max(600),
    options: z.array(materialExerciseOptionSchema).min(3).max(4),
    correct_key: z.string().min(1).max(8),
    explanation: z.string().min(1).max(600),
    evidence_quote: sourceQuoteSchema,
    source_chunk_seq: chunkSeqSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.options.map((option) => option.key);
    if (!keys.includes(value.correct_key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['correct_key'],
        message: '正确答案必须是 options 中的某个 key',
      });
    }
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: '选项 key 不得重复',
      });
    }
    if (value.evidence_quote.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_quote'],
        message: '必须给出原文依据，否则该题不可核验',
      });
    }
  });

export const materialExerciseSchema = z
  .object({
    exercises: z.array(materialExerciseItemSchema).min(1).max(12),
  })
  .strict();
export type MaterialExerciseResult = z.infer<typeof materialExerciseSchema>;
export type MaterialExerciseItem = z.infer<typeof materialExerciseItemSchema>;
export type MaterialExerciseOption = z.infer<typeof materialExerciseOptionSchema>;

// ── v2.7 规划域（T14）：全部 `.strict()`，多一个键即整条非法 ──

export const planExplainSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1).max(200),
            reason: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();
export type PlanExplainResult = z.infer<typeof planExplainSchema>;
export type PlanExplainTask = z.infer<typeof planExplainSchema>['tasks'][number];

export const planSuggestSchema = z
  .object({
    picks: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1).max(200),
            why: z.string().min(1).max(200),
            suggested_order: z.number().int().min(1).max(50),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type PlanSuggestResult = z.infer<typeof planSuggestSchema>;
export type PlanSuggestPick = z.infer<typeof planSuggestSchema>['picks'][number];

export const planWeeklyThemeSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            theme: z.string().min(1).max(80),
            rationale: z.string().min(1).max(300),
            evidence_refs: z.array(z.string().min(1).max(200)).max(6),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();
export type PlanWeeklyThemeResult = z.infer<typeof planWeeklyThemeSchema>;
export type PlanWeeklyThemeOption = z.infer<typeof planWeeklyThemeSchema>['options'][number];

export const SCHEMA_BY_KIND = {
  task: taskSpecSchema,
  diagnosis: diagnosisResultSchema,
  hint: hintResultSchema,
  teaching: feedbackResultSchema,
  drill: drillSetSchema,
  assessment: evidenceAssessmentSchema,
  reviewer: reviewerResultSchema,
  diag_routing: diagRoutingSchema,
  diag_speaking: diagEvaluationSchema,
  diag_writing: diagEvaluationSchema,
  diag_error: diagErrorSchema,
  diag_summary: diagSummarySchema,
  diag_plan: diagPlanSchema,
  material_extract: materialExtractSchema,
  material_summary: materialSummarySchema,
  material_exercise: materialExerciseSchema,
  plan_explain: planExplainSchema,
  plan_suggest_candidates: planSuggestSchema,
  plan_weekly_theme: planWeeklyThemeSchema,
} as const;

export type StructuredByKind = {
  task: TaskSpec;
  diagnosis: DiagnosisResult;
  hint: HintResult;
  teaching: FeedbackResult;
  drill: DrillSet;
  assessment: EvidenceAssessment;
  reviewer: ReviewerResult;
  diag_routing: DiagnosticRouting;
  diag_speaking: DiagnosticEvaluation;
  diag_writing: DiagnosticEvaluation;
  diag_error: DiagnosticError;
  diag_summary: DiagnosticSummary;
  diag_plan: DiagnosticPlan;
  material_extract: MaterialExtractResult;
  material_summary: MaterialSummaryResult;
  material_exercise: MaterialExerciseResult;
  plan_explain: PlanExplainResult;
  plan_suggest_candidates: PlanSuggestResult;
  plan_weekly_theme: PlanWeeklyThemeResult;
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