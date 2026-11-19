'use server';

/**
 * AI 建议 Actions（P5：规则引擎建议）。
 *
 * 这是本地确定性规则引擎，不是大模型：
 * - `requestAiAnalysisAction` 按 scope 聚合真实数据 → 调 `domain/suggestion.ts` 生成建议；
 * - 每条建议都带 `basis`（数据依据，强制非空），落库 `AiSuggestion`（status=available）；
 * - 建议与成绩表物理分离（R9），绝不写成绩、不自动改配比、不自动切阶段。
 */

import { revalidatePath } from 'next/cache';
import { AI_SCOPE_LABEL_ZH } from '@/lib/constants';
import { today } from '@/lib/date';
import {
  buildPlanSuggestions,
  buildWeaknessSuggestions,
  buildWeeklySuggestions,
  type SuggestionDraft,
} from '@/lib/domain/suggestion';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import { nullIfEmpty } from '@/lib/schema/common';
import { requestAiAnalysisSchema, upsertAiSuggestionSchema } from '@/lib/schema/ai';
import {
  getPlanAllocationSnapshot,
  getWeaknessSuggestionInput,
  getWeeklySuggestionInput,
} from '@/lib/queries/ai';
import type { ActionResult, AiScope } from '@/lib/types';

/** 写入一条 AI 建议（第二期由模型产出，本期手工/种子）。 */
export async function upsertAiSuggestionAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = upsertAiSuggestionSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const input = parsed.data;

  const created = await prisma.aiSuggestion.create({
    data: {
      scope: input.scope,
      refKey: nullIfEmpty(input.refKey),
      status: input.status ?? 'unavailable',
      title: input.title.trim(),
      body: input.body.trim(),
      basis: nullIfEmpty(input.basis),
      provider: nullIfEmpty(input.provider),
    },
  });

  revalidatePath('/analytics');
  revalidatePath('/settings');
  revalidatePath('/');
  return ok({ id: created.id });
}

/**
 * 请求生成 AI 建议。
 *
 * 按 scope 聚合真实数据 → 领域层生成建议 → 事务落库（status=available）。
 * 无数据时不生成（返回空数组），落库后 revalidate 相关页面。
 */
export async function requestAiAnalysisAction(
  raw: unknown,
): Promise<ActionResult<{ scope: AiScope; generated: number }>> {
  const parsed = requestAiAnalysisSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const scope = parsed.data.scope;
  const drafts = await generateDraftsForScope(scope);

  if (drafts.length === 0) {
    return fail(
      'PRECONDITION',
      `「${AI_SCOPE_LABEL_ZH[scope]}」暂无足够数据生成建议：先积累学习记录、周报或计划数据后再试。`,
    );
  }

  await prisma.$transaction(
    drafts.map((draft) =>
      prisma.aiSuggestion.create({
        data: {
          scope,
          status: 'available',
          title: draft.title,
          body: draft.body,
          basis: draft.basis,
          provider: 'rule-engine',
        },
      }),
    ),
  );

  revalidatePath('/analytics');
  revalidatePath('/weekly');
  revalidatePath('/settings');
  revalidatePath('/');
  return ok({ scope, generated: drafts.length });
}

/** 按 scope 生成建议草稿（真实数据 → 领域纯函数）。 */
async function generateDraftsForScope(scope: AiScope): Promise<SuggestionDraft[]> {
  const now = today();

  switch (scope) {
    case 'WEAKNESS': {
      const { ranked, insufficient } = await getWeaknessSuggestionInput(now);
      return buildWeaknessSuggestions(ranked, insufficient);
    }
    case 'WEEKLY': {
      const input = await getWeeklySuggestionInput(now);
      return buildWeeklySuggestions(input);
    }
    case 'PLAN': {
      const { minutes, target } = await getPlanAllocationSnapshot(now);
      if (!target) return [];
      return buildPlanSuggestions(minutes, target);
    }
    default:
      return [];
  }
}
