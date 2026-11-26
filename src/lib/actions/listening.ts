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
import type { ActionResult } from '@/lib/types';
import {
  deleteUploadedFile,
  writeUploadedFile,
} from '@/lib/storage';
import {
  audioAssetCreateSchema,
  assetDeletionPreviewSchema,
  assetDeletionConfirmSchema,
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
import { AUDIO_MAX_UPLOAD_BYTES, RECORDING_MAX_BYTES } from '@/lib/constants';
import { validateAudioUpload, AudioValidationError } from '@/lib/services/audioStorage';
import {
  previewAssetDeletion,
  confirmAssetDeletion,
  type PreviewDeletionData,
  type ConfirmDeletionData,
  type AssetReference,
} from '@/lib/services/assetDeletion';

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
  if (file.size > AUDIO_MAX_UPLOAD_BYTES) return fail('VALIDATION', '文件超过 50MB 上限');

  const metaRaw = formData.get('meta');
  let meta: AudioAssetCreateInput;
  try {
    meta = audioAssetCreateSchema.parse(metaRaw ? JSON.parse(String(metaRaw)) : { title: file.name });
  } catch (error) {
    return failValidation(error as never);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const fileName = meta.fileName ?? file.name;
  const declaredMimeType = meta.mimeType ?? file.type;
  if (meta.mimeType && file.type && meta.mimeType.split(';', 1)[0].trim().toLowerCase() !== file.type.split(';', 1)[0].trim().toLowerCase()) {
    return fail('VALIDATION', '文件与元数据声明的 MIME 不一致');
  }
  let validated;
  try {
    validated = validateAudioUpload({ bytes, fileName, declaredFileName: meta.fileName, declaredMimeType, declaredDurationSec: meta.durationSec });
  } catch (error) {
    return fail('VALIDATION', error instanceof AudioValidationError ? error.message : '音频校验失败');
  }

  let stored;
  try {
    stored = writeUploadedFile(bytes, validated.extension);
  } catch {
    return fail('INTERNAL', '音频落盘失败');
  }

  let asset;
  try {
    asset = await prisma.audioAsset.create({
      data: {
        title: meta.title,
        source: meta.source ?? 'UPLOAD',
        sourceUrl: null,
        filePath: stored.relativePath,
        fileName,
        mimeType: validated.inspection.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        durationSec: validated.durationSec,
        language: meta.language,
        dialectTag: meta.dialectTag,
        rightsInfo: meta.rightsInfo,
      },
    });
  } catch {
    // DB 写入失败时只清理本次刚创建的文件，不能留下孤立文件。
    deleteUploadedFile(stored.relativePath);
    return fail('INTERNAL', '音频登记失败');
  }

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
  if (file.size > RECORDING_MAX_BYTES) return fail('VALIDATION', '文件超过 1.6MB 上限');
  const sessionIdRaw = formData.get('sessionId');
  const durationRaw = formData.get('durationSec');

  const bytes = Buffer.from(await file.arrayBuffer());
  const durationValue = durationRaw === null || durationRaw === '' ? undefined : Number(durationRaw);
  let validated;
  try {
    validated = validateAudioUpload({
      bytes,
      fileName: file.name || 'recording.webm',
      declaredMimeType: file.type,
      declaredDurationSec: durationValue,
      recording: true,
    });
  } catch (error) {
    return fail('VALIDATION', error instanceof AudioValidationError ? error.message : '录音校验失败');
  }
  if (sessionIdRaw) {
    const session = await prisma.speakingSession.findUnique({ where: { id: String(sessionIdRaw) }, select: { id: true } });
    if (!session) return fail('NOT_FOUND', '口语会话不存在');
  }

  let stored;
  try {
    stored = writeUploadedFile(bytes, validated.extension);
  } catch {
    return fail('INTERNAL', '录音落盘失败');
  }

  let recording;
  try {
    recording = await prisma.recordingAsset.create({
      data: {
        sessionId: sessionIdRaw ? String(sessionIdRaw) : null,
        filePath: stored.relativePath,
        mimeType: validated.inspection.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        durationSec: validated.durationSec,
        takeNumber: await nextTakeNumber(sessionIdRaw ? String(sessionIdRaw) : null),
      },
    });
  } catch {
    deleteUploadedFile(stored.relativePath);
    return fail('INTERNAL', '录音登记失败');
  }

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

  const asset = await prisma.audioAsset.findFirst({ where: { id: parsed.data.audioAssetId, deletedAt: null } });
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

  const exercise = await prisma.listeningExercise.findFirst({
    where: { id: parsed.data.exerciseId, audioAsset: { deletedAt: null } },
  });
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

  const attempt = await prisma.listeningAttempt.findFirst({
    where: { id: parsed.data.attemptId, exercise: { audioAsset: { deletedAt: null } } },
  });
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
  if (!parsed.data.audioAssetId && !parsed.data.recordingAssetId) return fail('VALIDATION', '转写必须关联音频或录音');
  if (parsed.data.audioAssetId) {
    const audio = await prisma.audioAsset.findFirst({ where: { id: parsed.data.audioAssetId, deletedAt: null }, select: { id: true } });
    if (!audio) return fail('NOT_FOUND', '音频资产不存在或已删除');
  }
  if (parsed.data.recordingAssetId) {
    const recording = await prisma.recordingAsset.findFirst({ where: { id: parsed.data.recordingAssetId, deletedAt: null }, select: { id: true } });
    if (!recording) return fail('NOT_FOUND', '录音资产不存在或已删除');
  }

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
  if (parsed.data.recordingAssetId) {
    const recording = await prisma.recordingAsset.findFirst({ where: { id: parsed.data.recordingAssetId, deletedAt: null }, select: { id: true } });
    if (!recording) return fail('NOT_FOUND', '录音资产不存在或已删除');
  }
  if (parsed.data.transcriptId) {
    const transcript = await prisma.transcript.findFirst({
      where: { id: parsed.data.transcriptId, OR: [
        { audioAsset: { deletedAt: null } },
        { recordingAsset: { deletedAt: null } },
      ] },
      select: { id: true },
    });
    if (!transcript) return fail('NOT_FOUND', '转写不存在或关联资产已删除');
  }

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

// ───────────────────────── 音频资产 tombstone 删除 ─────────────────────────

/** 只读影响预览：包含将被保留的子记录数量，以及必须阻止删除的证据/诊断引用 ID。 */
export async function previewAudioAssetDeletionAction(input: unknown): Promise<ActionResult<PreviewDeletionData> & { references?: AssetReference[] }> {
  const parsed = assetDeletionPreviewSchema.safeParse(input);
  if (!parsed.success) return failValidation<PreviewDeletionData>(parsed.error);
  const result = await previewAssetDeletion(prisma, parsed.data.kind, parsed.data.assetId, parsed.data.reason);
  if (!result.ok) return fail<PreviewDeletionData>(result.code, result.error);
  return ok(result.data);
}

/** 二次确认 + 事务重新检查引用；不接收路径，不物理删除行或文件。 */
export async function confirmAssetDeletionAction(input: unknown): Promise<ActionResult<ConfirmDeletionData> & { references?: AssetReference[] }> {
  const parsed = assetDeletionConfirmSchema.safeParse(input);
  if (!parsed.success) return failValidation<ConfirmDeletionData>(parsed.error);
  const result = await confirmAssetDeletion(prisma, parsed.data);
  if (!result.ok) return { ...result };
  revalidatePath('/listening');
  revalidatePath('/speaking');
  return ok(result.data);
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
