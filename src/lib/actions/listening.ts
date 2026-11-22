/**
 * v2.5 Listening & Speaking Lab — Server Actions。
 *
 * 约定：写操作全走 Server Action 返回 `ActionResult<T>`；失败返回而非 throw；
 * 所有输入经 zod 校验；音频二进制不写 DB（见 storage.ts）。
 */

'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { ok, fail, failValidation } from '@/lib/result';
import {
  isAllowedExtension,
  writeUploadedFile,
} from '@/lib/storage';
import {
  AUDIO_MAX_UPLOAD_BYTES,
  RECORDING_MAX_BYTES,
} from '@/lib/constants';
import {
  audioAssetCreateSchema,
  listeningExerciseCreateSchema,
  listeningAttemptSubmitSchema,
  listeningErrorCreateSchema,
  transcriptUpsertSchema,
  speakingPromptCreateSchema,
  speakingSessionCreateSchema,
  speakingTurnCreateSchema,
} from '@/lib/schema/listening';
import type {
  AudioAssetCreateInput,
  ListeningExerciseCreateInput,
  ListeningAttemptSubmitInput,
  ListeningErrorCreateInput,
  TranscriptUpsertInput,
  SpeakingPromptCreateInput,
  SpeakingSessionCreateInput,
  SpeakingTurnCreateInput,
} from '@/lib/schema/listening';
import { hasNoListeningOutput } from '@/lib/domain/listening';

// ───────────────────────── 音频资产 ─────────────────────────

/**
 * 上传音频：multipart 的 file 字段 + JSON 元数据。
 * 服务端校验 MIME / 大小 / 扩展名，计算 sha256 落盘，DB 存元数据。
 */
export async function uploadAudioAction(formData: FormData): Promise<
  | { ok: true; data: { id: string; filePath: string; sha256: string; sizeBytes: number } }
  | { ok: false; code: string; error: string }
> {
  const file = formData.get('file');
  if (!(file instanceof File)) return fail('VALIDATION', '缺少音频文件');

  const metaRaw = formData.get('meta');
  let meta: AudioAssetCreateInput;
  try {
    meta = audioAssetCreateSchema.parse(metaRaw ? JSON.parse(String(metaRaw)) : { title: file.name });
  } catch (error) {
    return failValidation(error as never);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) return fail('VALIDATION', '文件为空');
  if (bytes.byteLength > AUDIO_MAX_UPLOAD_BYTES) {
    return fail('VALIDATION', `文件超过上限（${Math.round(AUDIO_MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
  }

  const ext = meta.fileName
    ? meta.fileName.slice(meta.fileName.lastIndexOf('.') + 1)
    : file.name.slice(file.name.lastIndexOf('.') + 1);
  if (!isAllowedExtension(ext)) return fail('VALIDATION', '不支持的音频格式');

  let stored;
  try {
    stored = writeUploadedFile(bytes, ext);
  } catch {
    return fail('INTERNAL', '音频落盘失败');
  }

  const asset = await prisma.audioAsset.create({
    data: {
      title: meta.title,
      source: meta.source ?? 'UPLOAD',
      sourceUrl: null,
      filePath: stored.relativePath,
      fileName: meta.fileName ?? file.name,
      mimeType: meta.mimeType ?? file.type,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      durationSec: meta.durationSec,
      language: meta.language,
      dialectTag: meta.dialectTag,
      rightsInfo: meta.rightsInfo,
    },
  });

  revalidatePath('/listening');
  return ok({ id: asset.id, filePath: asset.filePath, sha256: stored.sha256, sizeBytes: stored.sizeBytes });
}

/** 录音落盘（Speaking Recorder，webm，上限 1.6MB）。 */
export async function uploadRecordingAction(formData: FormData): Promise<
  | { ok: true; data: { id: string; filePath: string; durationSec?: number } }
  | { ok: false; code: string; error: string }
> {
  const file = formData.get('file');
  if (!(file instanceof File)) return fail('VALIDATION', '缺少录音文件');
  const sessionIdRaw = formData.get('sessionId');
  const durationRaw = formData.get('durationSec');

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) return fail('VALIDATION', '录音为空');
  if (bytes.byteLength > RECORDING_MAX_BYTES) return fail('VALIDATION', '录音超过 1.6MB 上限');

  let stored;
  try {
    stored = writeUploadedFile(bytes, 'webm');
  } catch {
    return fail('INTERNAL', '录音落盘失败');
  }

  const durationSec = durationRaw ? Number(durationRaw) : undefined;
  const recording = await prisma.recordingAsset.create({
    data: {
      sessionId: sessionIdRaw ? String(sessionIdRaw) : null,
      filePath: stored.relativePath,
      mimeType: file.type || 'audio/webm',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      durationSec: durationSec && Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
      takeNumber: await nextTakeNumber(sessionIdRaw ? String(sessionIdRaw) : null),
    },
  });

  revalidatePath('/speaking');
  return ok({ id: recording.id, filePath: recording.filePath, durationSec: recording.durationSec ?? undefined });
}

async function nextTakeNumber(sessionId: string | null): Promise<number> {
  if (!sessionId) return 1;
  const count = await prisma.recordingAsset.count({ where: { sessionId } });
  return count + 1;
}

// ───────────────────────── 听力练习 ─────────────────────────

export async function createListeningExerciseAction(
  input: ListeningExerciseCreateInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = listeningExerciseCreateSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const asset = await prisma.audioAsset.findUnique({ where: { id: parsed.data.audioAssetId } });
  if (!asset) return fail('NOT_FOUND', '音频资产不存在');

  const exercise = await prisma.listeningExercise.create({
    data: {
      audioAssetId: parsed.data.audioAssetId,
      mode: parsed.data.mode,
      title: parsed.data.title,
      promptJson: parsed.data.prompt ? JSON.stringify({ prompt: parsed.data.prompt }) : null,
    },
  });

  revalidatePath('/listening');
  return ok({ id: exercise.id });
}

export async function submitListeningAttemptAction(
  input: ListeningAttemptSubmitInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = listeningAttemptSubmitSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const exercise = await prisma.listeningExercise.findUnique({ where: { id: parsed.data.exerciseId } });
  if (!exercise) return fail('NOT_FOUND', '听力练习不存在');

  // 首听与辅助后结果分离保存；两者都空则无有效产出，仍记录但状态 DRAFT。
  const attempt = await prisma.listeningAttempt.create({
    data: {
      exerciseId: parsed.data.exerciseId,
      firstListenResultJson: parsed.data.firstListenResult
        ? JSON.stringify({ text: parsed.data.firstListenResult })
        : null,
      assistedResultJson: parsed.data.assistedResult
        ? JSON.stringify({ text: parsed.data.assistedResult })
        : null,
      replayCount: parsed.data.replayCount ?? 0,
      status: hasNoListeningOutput(parsed.data.firstListenResult, parsed.data.assistedResult)
        ? 'DRAFT'
        : 'SUBMITTED',
    },
  });

  revalidatePath('/listening');
  return ok({ id: attempt.id });
}

export async function createListeningErrorAction(
  input: ListeningErrorCreateInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = listeningErrorCreateSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const attempt = await prisma.listeningAttempt.findUnique({ where: { id: parsed.data.attemptId } });
  if (!attempt) return fail('NOT_FOUND', '听力作答不存在');

  const error = await prisma.listeningError.create({
    data: {
      attemptId: parsed.data.attemptId,
      errorType: parsed.data.errorType,
      source: 'USER',
      isTechnical: parsed.data.isTechnical ?? false,
      note: parsed.data.note || null,
    },
  });

  return ok({ id: error.id });
}

// ───────────────────────── 转写 ─────────────────────────

export async function upsertTranscriptAction(
  input: TranscriptUpsertInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = transcriptUpsertSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const transcript = await prisma.transcript.create({
    data: {
      audioAssetId: parsed.data.audioAssetId ?? null,
      recordingAssetId: parsed.data.recordingAssetId ?? null,
      kind: parsed.data.kind ?? 'MANUAL',
      language: parsed.data.language ?? null,
      confidence: parsed.data.confidence ?? null,
      status: 'CONFIRMED',
      segments: {
        create: parsed.data.segments.map((segment) => ({
          seq: segment.seq,
          startMs: segment.startMs ?? null,
          endMs: segment.endMs ?? null,
          text: segment.text,
        })),
      },
    },
  });

  return ok({ id: transcript.id });
}

// ───────────────────────── 口语 ─────────────────────────

export async function createSpeakingPromptAction(
  input: SpeakingPromptCreateInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = speakingPromptCreateSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const prompt = await prisma.speakingPrompt.create({
    data: {
      taskType: parsed.data.taskType,
      title: parsed.data.title,
      prompt: parsed.data.prompt,
      rubricVersion: 'speaking.rubric.v1',
    },
  });

  revalidatePath('/speaking');
  return ok({ id: prompt.id });
}

export async function createSpeakingSessionAction(
  input: SpeakingSessionCreateInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = speakingSessionCreateSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const session = await prisma.speakingSession.create({
    data: {
      promptId: parsed.data.promptId ?? null,
      mode: parsed.data.mode ?? 'PRACTICE',
      status: 'ACTIVE',
    },
  });

  revalidatePath('/speaking');
  return ok({ id: session.id });
}

export async function addSpeakingTurnAction(
  input: SpeakingTurnCreateInput,
): Promise<{ ok: true; data: { id: string } } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> }> {
  const parsed = speakingTurnCreateSchema.safeParse(input);
  if (!parsed.success) return failValidation(parsed.error);

  const session = await prisma.speakingSession.findUnique({ where: { id: parsed.data.sessionId } });
  if (!session) return fail('NOT_FOUND', '口语会话不存在');

  const maxSeq = await prisma.speakingTurn.aggregate({
    where: { sessionId: parsed.data.sessionId },
    _max: { seq: true },
  });

  const turn = await prisma.speakingTurn.create({
    data: {
      sessionId: parsed.data.sessionId,
      role: parsed.data.role,
      seq: (maxSeq._max.seq ?? 0) + 1,
      text: parsed.data.text || null,
      recordingAssetId: parsed.data.recordingAssetId ?? null,
      transcriptId: parsed.data.transcriptId ?? null,
    },
  });

  return ok({ id: turn.id });
}

// ───────────────────────── 退出系统 ─────────────────────────

/**
 * 退出系统关闭程序：由前端二次确认后调用。
 * 单用户本机应用，直接优雅终止进程（关闭 dev server / 生产服务）。
 */
export async function shutdownApplicationAction(): Promise<
  { ok: true; data: { message: string } } | { ok: false; code: string; error: string }
> {
  // 延迟 300ms 让响应先返回给前端，再终止进程。
  setTimeout(() => {
    process.exit(0);
  }, 300);
  return ok({ message: '正在关闭应用…' });
}
