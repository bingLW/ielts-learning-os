/**
 * v2.5 Listening & Speaking Lab — 只读查询。
 */

import { prisma } from '@/lib/prisma';
import { parseJson } from '@/lib/json';

export interface AudioAssetDto {
  id: string;
  title: string;
  source: string;
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  durationSec: number | null;
  language: string | null;
  dialectTag: string | null;
  createdAt: Date;
}

export async function listAudioAssets(): Promise<AudioAssetDto[]> {
  const rows = await prisma.audioAsset.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source,
    filePath: row.filePath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    durationSec: row.durationSec,
    language: row.language,
    dialectTag: row.dialectTag,
    createdAt: row.createdAt,
  }));
}

export async function getAudioAsset(id: string): Promise<AudioAssetDto | null> {
  const row = await prisma.audioAsset.findFirst({ where: { id, deletedAt: null } });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    filePath: row.filePath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    durationSec: row.durationSec,
    language: row.language,
    dialectTag: row.dialectTag,
    createdAt: row.createdAt,
  };
}

export interface ListeningExerciseDto {
  id: string;
  audioAssetId: string;
  mode: string;
  title: string;
  prompt: string | null;
  attempts: Array<{
    id: string;
    firstListenResult: string | null;
    assistedResult: string | null;
    replayCount: number;
    status: string;
    errors: Array<{ id: string; errorType: string; isTechnical: boolean; note: string | null }>;
  }>;
}

export async function listListeningExercises(): Promise<ListeningExerciseDto[]> {
  const rows = await prisma.listeningExercise.findMany({
    where: { audioAsset: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    include: {
      attempts: {
        orderBy: { createdAt: 'desc' },
        include: { errors: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    audioAssetId: row.audioAssetId,
    mode: row.mode,
    title: row.title,
    prompt: parseJson<{ prompt: string } | null>(row.promptJson, null)?.prompt ?? null,
    attempts: row.attempts.map((attempt) => ({
      id: attempt.id,
      firstListenResult: parseJson<{ text: string } | null>(attempt.firstListenResultJson, null)?.text ?? null,
      assistedResult: parseJson<{ text: string } | null>(attempt.assistedResultJson, null)?.text ?? null,
      replayCount: attempt.replayCount,
      status: attempt.status,
      errors: attempt.errors.map((error) => ({
        id: error.id,
        errorType: error.errorType,
        isTechnical: error.isTechnical,
        note: error.note,
      })),
    })),
  }));
}

export interface TranscriptDto {
  id: string;
  kind: string;
  language: string | null;
  confidence: string | null;
  segments: Array<{ seq: number; startMs: number | null; endMs: number | null; text: string }>;
}

export async function listTranscriptsForAudio(audioAssetId: string): Promise<TranscriptDto[]> {
  const rows = await prisma.transcript.findMany({
    where: { audioAssetId, audioAsset: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    include: { segments: { orderBy: { seq: 'asc' } } },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    language: row.language,
    confidence: row.confidence,
    segments: row.segments.map((segment) => ({
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  }));
}

export interface SpeakingPromptDto {
  id: string;
  taskType: string;
  title: string;
  prompt: string;
}

export async function listSpeakingPrompts(): Promise<SpeakingPromptDto[]> {
  const rows = await prisma.speakingPrompt.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } });
  return rows.map((row) => ({
    id: row.id,
    taskType: row.taskType,
    title: row.title,
    prompt: row.prompt,
  }));
}

export interface SpeakingRecordingDto {
  id: string;
  filePath: string;
  durationSec: number | null;
  takeNumber: number;
  createdAt: Date;
}

export async function listUnassignedRecordings(): Promise<SpeakingRecordingDto[]> {
  return prisma.recordingAsset.findMany({
    where: { sessionId: null, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filePath: true, durationSec: true, takeNumber: true, createdAt: true },
  });
}

export interface SpeakingSessionDto {
  id: string;
  promptId: string | null;
  mode: string;
  status: string;
  turns: Array<{ id: string; role: string; seq: number; text: string | null }>;
  recordings: Array<{ id: string; filePath: string; durationSec: number | null; takeNumber: number }>;
}

export async function listSpeakingSessions(): Promise<SpeakingSessionDto[]> {
  const rows = await prisma.speakingSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      turns: { orderBy: { seq: 'asc' } },
      recordings: { where: { deletedAt: null }, orderBy: { takeNumber: 'asc' } },
    },
  });
  const recordingIds = rows.flatMap((row) => row.turns.flatMap((turn) => turn.recordingAssetId ? [turn.recordingAssetId] : []));
  const transcriptIds = rows.flatMap((row) => row.turns.flatMap((turn) => turn.transcriptId ? [turn.transcriptId] : []));
  const [deletedRecordings, deletedTranscripts] = await Promise.all([
    prisma.recordingAsset.findMany({ where: { id: { in: recordingIds }, deletedAt: { not: null } }, select: { id: true } }),
    prisma.transcript.findMany({
      where: { id: { in: transcriptIds }, OR: [{ audioAsset: { deletedAt: { not: null } } }, { recordingAsset: { deletedAt: { not: null } } }] },
      select: { id: true },
    }),
  ]);
  const deletedRecordingSet = new Set(deletedRecordings.map((row) => row.id));
  const deletedTranscriptSet = new Set(deletedTranscripts.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    promptId: row.promptId,
    mode: row.mode,
    status: row.status,
    turns: row.turns.filter((turn) =>
      (!turn.recordingAssetId || !deletedRecordingSet.has(turn.recordingAssetId))
      && (!turn.transcriptId || !deletedTranscriptSet.has(turn.transcriptId)),
    ).map((turn) => ({
      id: turn.id,
      role: turn.role,
      seq: turn.seq,
      text: turn.text,
    })),
    recordings: row.recordings.map((recording) => ({
      id: recording.id,
      filePath: recording.filePath,
      durationSec: recording.durationSec,
      takeNumber: recording.takeNumber,
    })),
  }));
}
