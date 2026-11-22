'use server';

/** v2.4.1 诊断 Server Actions：开始、作答、暂停、生成报告、确认计划、复核与补测。 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import type { ActionResult } from '@/lib/types';
import {
  activatePlanSchema,
  pauseSchema,
  reportIdSchema,
  reviewSchema,
  sessionIdSchema,
  startDiagnosticSchema,
  submitAttemptSchema,
} from '@/lib/schema/diagnostics';
import {
  activatePlanProposal,
  createDiagnosticSession,
  createRetestSession,
  deleteDiagnosticSession,
  finalizeDiagnosticSession,
  requestDiagnosticReview,
  setSessionPaused,
  submitDiagnosticAttempt,
} from '@/lib/diagnostic/service';

function refresh() {
  revalidatePath('/diagnostics');
  revalidatePath('/');
}

export async function startDiagnosticAction(raw: unknown): Promise<ActionResult<{ sessionId: string }>> {
  const parsed = startDiagnosticSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const data = parsed.data;

  try {
    const { sessionId } = await createDiagnosticSession(prisma, {
      includeEmlr: data.includeEmlr,
      goals: data.goals,
      background: data.background as unknown as Record<string, unknown>,
    });
    await prisma.learnerProfile.update({
      where: { id: 'default' },
      data: {
        recordingConsent: Boolean(data.background.recordingConsent),
        externalAiConsent: Boolean(data.background.externalAiConsent),
        selfReportedWeaknessJson: data.background.selfWeakness
          ? JSON.stringify([data.background.selfWeakness])
          : null,
      },
    });
    refresh();
    return ok({ sessionId });
  } catch (error) {
    return fail('INTERNAL', error instanceof Error ? error.message : '无法开始诊断');
  }
}

export async function submitAttemptAction(
  raw: unknown,
): Promise<ActionResult<{ status: string; nextItemId: string | null; pendingEvaluation: boolean }>> {
  const parsed = submitAttemptSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const result = await submitDiagnosticAttempt(prisma, parsed.data);
  if (!result.ok) {
    return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION', result.message);
  }
  revalidatePath(`/diagnostics/${parsed.data.sessionId}`);
  return ok({
    status: result.status,
    nextItemId: result.nextItemId,
    pendingEvaluation: result.pendingEvaluation,
  });
}

export async function pauseDiagnosticAction(
  raw: unknown,
): Promise<ActionResult<{ status: string }>> {
  const parsed = pauseSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await setSessionPaused(prisma, parsed.data.sessionId, parsed.data.paused);
  if (!result.ok) return fail('NOT_FOUND', result.message);
  revalidatePath(`/diagnostics/${parsed.data.sessionId}`);
  return ok({ status: result.status });
}

export async function finalizeDiagnosticAction(
  raw: unknown,
): Promise<ActionResult<{ reportId: string; provisional: boolean }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await finalizeDiagnosticSession(prisma, parsed.data.sessionId);
  if (!result.ok) {
    return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION', result.message);
  }
  revalidatePath('/diagnostics');
  revalidatePath(`/diagnostics/${parsed.data.sessionId}`);
  revalidatePath(`/diagnostics/report/${result.reportId}`);
  return ok({ reportId: result.reportId, provisional: result.provisional });
}

export async function activatePlanAction(raw: unknown): Promise<ActionResult<{ activated: true }>> {
  const parsed = activatePlanSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await activatePlanProposal(prisma, parsed.data.proposalId, parsed.data.tasks);
  if (!result.ok) return fail('NOT_FOUND', result.message);
  revalidatePath('/diagnostics');
  revalidatePath('/plan');
  return ok({ activated: true });
}

export async function requestReviewAction(raw: unknown): Promise<ActionResult<{ requested: true }>> {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await requestDiagnosticReview(prisma, parsed.data.reportId, parsed.data.reason);
  if (!result.ok) return fail('NOT_FOUND', result.message);
  revalidatePath(`/diagnostics/report/${parsed.data.reportId}`);
  return ok({ requested: true });
}

export async function retestAction(
  raw: unknown,
): Promise<ActionResult<{ sessionId: string }>> {
  const parsed = reportIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await createRetestSession(prisma, parsed.data.reportId);
  if (!result.ok) return fail('NOT_FOUND', result.message);
  refresh();
  return ok({ sessionId: result.sessionId });
}

export async function deleteDiagnosticSessionAction(
  raw: unknown,
): Promise<ActionResult<{ deleted: true }>> {
  const parsed = sessionIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);
  const result = await deleteDiagnosticSession(prisma, parsed.data.sessionId);
  if (!result.ok) return fail('NOT_FOUND', result.message);
  refresh();
  return ok({ deleted: true });
}