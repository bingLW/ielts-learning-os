/** v2.4.1 诊断 Server Action 输入校验。 */

import { z } from 'zod';
import { DIAG_AUDIO_MAX_BYTES } from '@/lib/diagnostic/constants';

export const startDiagnosticSchema = z.object({
  includeEmlr: z.boolean().default(false),
  goals: z.array(z.string().min(1).max(40)).max(6).default([]),
  background: z
    .object({
      examType: z.string().max(40).optional(),
      targetNote: z.string().max(300).optional(),
      materials: z.string().max(500).optional(),
      usageFrequency: z.enum(['RARELY', 'SOMETIMES', 'OFTEN', 'DAILY']).optional(),
      weeklyMinutes: z.coerce.number().int().min(0).max(3000).optional(),
      recordingConsent: z.boolean().optional(),
      externalAiConsent: z.boolean().optional(),
      selfWeakness: z.string().max(300).optional(),
    })
    .default({}),
});
export type StartDiagnosticInput = z.infer<typeof startDiagnosticSchema>;

export const submitAttemptSchema = z.object({
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
  responseText: z.string().max(8000).default(''),
  timeSpentSec: z.coerce.number().int().min(0).max(7200).optional(),
  technicalFailed: z.boolean().optional(),
  technicalReason: z.string().max(300).optional(),
  clientRequestId: z.string().max(80).optional(),
  audioDataUrl: z.string().max(DIAG_AUDIO_MAX_BYTES).optional(),
  audioMime: z.string().max(60).optional(),
  audioDurationSec: z.coerce.number().int().min(0).max(600).optional(),
});

export const sessionIdSchema = z.object({ sessionId: z.string().min(1) });

export const pauseSchema = z.object({
  sessionId: z.string().min(1),
  paused: z.boolean(),
});

export const activatePlanSchema = z.object({
  proposalId: z.string().min(1),
  tasks: z
    .array(
      z.object({
        window: z.enum(['7D', '30D', '90D']),
        focus: z.string().max(200),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(120),
              minutes: z.coerce.number().int().min(5).max(240),
              skill: z.string().max(40),
              evidenceRef: z.string().max(200),
              reason: z.string().max(400),
            }),
          )
          .max(8),
      }),
    )
    .max(3)
    .optional(),
});

export const reviewSchema = z.object({
  reportId: z.string().min(1),
  reason: z.string().min(5, '请说明申请复核的原因').max(1000),
});

export const reportIdSchema = z.object({ reportId: z.string().min(1) });