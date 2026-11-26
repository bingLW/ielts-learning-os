/** v2.4.1 诊断 Server Action 输入校验。 */

import { z } from 'zod';
import { RECORDING_MAX_BYTES } from '@/lib/constants';

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

export const DIAGNOSTIC_AUDIO_DATA_URL_PREFIX = 'data:audio/webm;base64,';
export const DIAGNOSTIC_AUDIO_DATA_URL_MAX_LENGTH = DIAGNOSTIC_AUDIO_DATA_URL_PREFIX.length
  + 4 * Math.ceil(RECORDING_MAX_BYTES / 3);

/** 只接受浏览器 FileReader 生成的标准、带填充位的 WebM base64 data URL。 */
export function decodeDiagnosticAudioDataUrl(value: string): Buffer {
  if (value.length > DIAGNOSTIC_AUDIO_DATA_URL_MAX_LENGTH || !value.startsWith(DIAGNOSTIC_AUDIO_DATA_URL_PREFIX)) {
    throw new Error('录音必须是严格的 data:audio/webm;base64,... 格式');
  }
  const payload = value.slice(DIAGNOSTIC_AUDIO_DATA_URL_PREFIX.length);
  if (!payload || payload.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    throw new Error('录音 base64 数据无效');
  }
  const bytes = Buffer.from(payload, 'base64');
  // Node 的 base64 解码会容忍非法填充位；往返比较确保编码本身也是严格规范的。
  if (bytes.toString('base64') !== payload) throw new Error('录音 base64 数据无效');
  return bytes;
}

export const submitAttemptSchema = z.object({
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
  responseText: z.string().max(8000).default(''),
  timeSpentSec: z.coerce.number().int().min(0).max(7200).optional(),
  technicalFailed: z.boolean().optional(),
  technicalReason: z.string().max(300).optional(),
  clientRequestId: z.string().max(80).optional(),
  audioDataUrl: z.string().max(DIAGNOSTIC_AUDIO_DATA_URL_MAX_LENGTH)
    .refine((value) => {
      try {
        decodeDiagnosticAudioDataUrl(value);
        return true;
      } catch {
        return false;
      }
    }, '录音必须是严格的 data:audio/webm;base64,... 格式').optional(),
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