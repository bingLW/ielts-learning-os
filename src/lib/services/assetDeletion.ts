/**
 * v2.7.1 AudioAsset / RecordingAsset tombstone 删除服务。
 *
 * 单用户本地应用的权限边界：只允许 Server Action 按已登记 ID 操作，客户端不能提交
 * 文件路径。预览零写入；确认令牌绑定资产、引用快照和删除原因，且只在事务内复核后
 * 才更新 deletedAt。绝不删除子行、证据或物理文件。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ASSET_DELETE_PREVIEW_TTL_MS } from '@/lib/constants';

export type DeletableAssetKind = 'audio' | 'recording';
type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AssetReference {
  model: string;
  id: string;
}

export interface AssetDeletionPreview {
  kind: DeletableAssetKind;
  assetId: string;
  title: string;
  fingerprint: string;
  affected: {
    transcripts: number;
    transcriptSegments: number;
    listeningExercises: number;
    listeningAttempts: number;
    listeningErrors: number;
    speakingSessions: number;
    speakingTurns: number;
    asrResults: number;
    speechEvaluations: number;
    audioTechnicalChecks: number;
  };
  references: AssetReference[];
  fileRetained: boolean;
  historyRetained: boolean;
}

export interface AssetDeletionServiceResult<T> {
  ok: true;
  data: T;
}

export type PreviewDeletionData = { preview: AssetDeletionPreview; previewToken: string };
export type ConfirmDeletionData = { id: string; deletedAt: string; retainedChildRecords: number; retainedReferences: number };

export interface AssetDeletionServiceFailure {
  ok: false;
  code: 'NOT_FOUND' | 'VALIDATION' | 'PRECONDITION' | 'CONFLICT' | 'INTERNAL';
  error: string;
  references?: AssetReference[];
}

export type AssetDeletionResult<T> = AssetDeletionServiceResult<T> | AssetDeletionServiceFailure;

function failure(
  code: AssetDeletionServiceFailure['code'],
  error: string,
  references?: AssetReference[],
): AssetDeletionServiceFailure {
  return { ok: false, code, error, ...(references?.length ? { references } : {}) };
}

function emptyAffected(): AssetDeletionPreview['affected'] {
  return {
    transcripts: 0,
    transcriptSegments: 0,
    listeningExercises: 0,
    listeningAttempts: 0,
    listeningErrors: 0,
    speakingSessions: 0,
    speakingTurns: 0,
    asrResults: 0,
    speechEvaluations: 0,
    audioTechnicalChecks: 0,
  };
}

async function inspectAsset(db: DbClient, kind: DeletableAssetKind, assetId: string): Promise<AssetDeletionPreview | null> {
  const asset = kind === 'audio'
    ? await db.audioAsset.findUnique({ where: { id: assetId }, select: { id: true, title: true, filePath: true, sha256: true, deletedAt: true } })
    : await db.recordingAsset.findUnique({ where: { id: assetId }, select: { id: true, sessionId: true, filePath: true, sha256: true, deletedAt: true } });
  if (!asset) return null;

  const affected = emptyAffected();
  let exerciseIds: string[] = [];
  let attemptIds: string[] = [];
  let transcriptIds: string[] = [];
  let sessionIds: string[] = [];
  let evaluationIds: string[] = [];

  if (kind === 'audio') {
    const [exercises, transcripts] = await Promise.all([
      db.listeningExercise.findMany({ where: { audioAssetId: assetId }, select: { id: true } }),
      db.transcript.findMany({ where: { audioAssetId: assetId }, select: { id: true } }),
    ]);
    exerciseIds = exercises.map((row) => row.id);
    transcriptIds = transcripts.map((row) => row.id);
    affected.listeningExercises = exerciseIds.length;
    affected.transcripts = transcriptIds.length;
    affected.transcriptSegments = await db.transcriptSegment.count({ where: { transcriptId: { in: transcriptIds } } });
    affected.speakingTurns = await db.speakingTurn.count({ where: { transcriptId: { in: transcriptIds } } });
  } else {
    const [transcripts, sessions] = await Promise.all([
      db.transcript.findMany({ where: { recordingAssetId: assetId }, select: { id: true } }),
      db.recordingAsset.findUnique({ where: { id: assetId }, select: { sessionId: true } }),
    ]);
    transcriptIds = transcripts.map((row) => row.id);
    affected.transcripts = transcriptIds.length;
    affected.transcriptSegments = await db.transcriptSegment.count({ where: { transcriptId: { in: transcriptIds } } });
    affected.asrResults = await db.aSRResult.count({ where: { recordingAssetId: assetId } });
    const evaluations = await db.speechEvaluation.findMany({ where: { recordingAssetId: assetId }, select: { id: true }, orderBy: { id: 'asc' } });
    affected.speechEvaluations = evaluations.length;
    evaluationIds = evaluations.map((row) => row.id);
    affected.audioTechnicalChecks = await db.audioTechnicalCheck.count({ where: { recordingAssetId: assetId } });
    if (sessions?.sessionId) {
      sessionIds = [sessions.sessionId];
      affected.speakingSessions = await db.speakingSession.count({ where: { id: sessions.sessionId } });
    }
  }

  if (exerciseIds.length) {
    const attempts = await db.listeningAttempt.findMany({ where: { exerciseId: { in: exerciseIds } }, select: { id: true } });
    attemptIds = attempts.map((row) => row.id);
    affected.listeningAttempts = attemptIds.length;
    affected.listeningErrors = await db.listeningError.count({ where: { attemptId: { in: attemptIds } } });
  }
  if (kind === 'recording') {
    affected.speakingTurns = await db.speakingTurn.count({
      where: { OR: [
        ...(sessionIds.length ? [{ sessionId: { in: sessionIds } }] : []),
        { recordingAssetId: assetId },
        ...(transcriptIds.length ? [{ transcriptId: { in: transcriptIds } }] : []),
      ] },
    });
  }

  const tokens = [assetId, asset.filePath, ...(asset.sha256 ? [asset.sha256] : [])];
  const evidenceMention = { OR: [
    ...['outputText', 'conditionJson', 'evidenceAnchor', 'dimensionsJson', 'note'].flatMap((field) =>
      tokens.map((token) => ({ [field]: { contains: token } }))),
  ] };
  const linkedEvidenceIds = attemptIds.length
    ? (await db.listeningAttempt.findMany({ where: { id: { in: attemptIds }, evidenceId: { not: null } }, select: { evidenceId: true } }))
      .flatMap((row) => row.evidenceId ? [row.evidenceId] : [])
    : [];

  const references: AssetReference[] = [];
  const add = (model: string, ids: string[]) => {
    for (const id of new Set(ids)) if (!references.some((row) => row.model === model && row.id === id)) references.push({ model, id });
  };

  const [evidences, diagnosticAttempts, diagnosticAssets, materialAssets, permissionRecords, candidates, tasks, evidenceAttachments, learningOutputs, aiUsageRecords] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { OR: [evidenceMention, ...(linkedEvidenceIds.length ? [{ id: { in: linkedEvidenceIds } }] : [])] },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.diagnosticAttempt.findMany({
      where: { OR: [
        ...['responseText', 'responseJson', 'technicalStatusJson'].flatMap((field) =>
          tokens.map((token) => ({ [field]: { contains: token } }))),
      ] },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.diagnosticAsset.findMany({
      where: { OR: [
        ...tokens.map((token) => ({ storagePath: { contains: token } })),
        ...(asset.sha256 ? [{ sha256: asset.sha256 }] : []),
      ] },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.materialAsset.findMany({
      where: { OR: [
        ...(kind === 'audio' ? [{ audioAssetId: assetId }] : []),
        { relativePath: { contains: asset.filePath } },
      ] },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.materialPermissionRecord.findMany({ where: { OR: tokens.map((token) => ({ note: { contains: token } })) }, select: { id: true }, orderBy: { id: 'asc' } }),
    db.taskCandidate.findMany({ where: { OR: [...['sourceRef', 'prerequisitesJson'].flatMap((field) => tokens.map((token) => ({ [field]: { contains: token } })))] }, select: { id: true }, orderBy: { id: 'asc' } }),
    db.planTask.findMany({ where: { OR: [...['note', 'decisionJson'].flatMap((field) => tokens.map((token) => ({ [field]: { contains: token } })))] }, select: { id: true }, orderBy: { id: 'asc' } }),
    db.evidenceAttachment.findMany({
      where: { OR: [
        ...['fileUri', 'note'].flatMap((field) => tokens.map((token) => ({ [field]: { contains: token } }))),
        ...(asset.sha256 ? [{ checksum: asset.sha256 }] : []),
      ] },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.learningOutput.findMany({
      where: { OR: ['uri', 'content'].flatMap((field) => tokens.map((token) => ({ [field]: { contains: token } }))) },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
    db.aIUsageRecord.findMany({
      where: { OR: ['inputRef', 'outputRef', 'userNote'].flatMap((field) => tokens.map((token) => ({ [field]: { contains: token } }))) },
      select: { id: true }, orderBy: { id: 'asc' },
    }),
  ]);
  add('SpeechEvaluation', evaluationIds);
  add('EvidenceRecord', evidences.map((row) => row.id));
  add('DiagnosticAttempt', diagnosticAttempts.map((row) => row.id));
  add('DiagnosticAsset', diagnosticAssets.map((row) => row.id));
  add('MaterialAsset', materialAssets.map((row) => row.id));
  add('MaterialPermissionRecord', permissionRecords.map((row) => row.id));
  add('TaskCandidate', candidates.map((row) => row.id));
  add('PlanTask', tasks.map((row) => row.id));
  add('EvidenceAttachment', evidenceAttachments.map((row) => row.id));
  add('LearningOutput', learningOutputs.map((row) => row.id));
  add('AIUsageRecord', aiUsageRecords.map((row) => row.id));

  return {
    kind,
    assetId,
    title: 'title' in asset ? asset.title : `录音 ${assetId}`,
    fingerprint: '',
    affected,
    references,
    fileRetained: true,
    historyRetained: true,
  };
}

const tokenSecret = randomBytes(32);

function sign(payload: string): string {
  return createHmac('sha256', tokenSecret).update(payload).digest('base64url');
}

function fingerprintOf(preview: AssetDeletionPreview, reason: string): string {
  return sign(JSON.stringify({
    kind: preview.kind,
    assetId: preview.assetId,
    reason: reason.trim(),
    affected: preview.affected,
    references: preview.references,
  }));
}

function encodePreviewToken(preview: AssetDeletionPreview, reason: string): string {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    kind: preview.kind,
    assetId: preview.assetId,
    reason: reason.trim(),
    fingerprint: fingerprintOf(preview, reason),
    expiresAt: Date.now() + ASSET_DELETE_PREVIEW_TTL_MS,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodePreviewToken(token: string): { kind: DeletableAssetKind; assetId: string; reason: string; fingerprint: string; expiresAt: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = sign(parts[0]);
  const supplied = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (supplied.length !== expectedBuffer.length || !timingSafeEqual(supplied, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt) || Number(payload.expiresAt) < Date.now()) return null;
    if (payload.kind !== 'audio' && payload.kind !== 'recording') return null;
    if (typeof payload.assetId !== 'string' || typeof payload.reason !== 'string' || typeof payload.fingerprint !== 'string') return null;
    return payload as { kind: DeletableAssetKind; assetId: string; reason: string; fingerprint: string; expiresAt: number };
  } catch {
    return null;
  }
}

export async function previewAssetDeletion(
  db: DbClient,
  kind: DeletableAssetKind,
  assetId: string,
  reason: string,
): Promise<AssetDeletionResult<PreviewDeletionData>> {
  const cleanReason = reason.trim();
  if (!cleanReason || cleanReason.length > 500) return failure('VALIDATION', '请填写 1–500 字的删除原因');
  try {
    const preview = await inspectAsset(db, kind, assetId);
    if (!preview) return failure('NOT_FOUND', kind === 'audio' ? '音频资产不存在' : '录音资产不存在');
    if (kind === 'audio' && await db.audioAsset.count({ where: { id: assetId, deletedAt: { not: null } } })) {
      return failure('CONFLICT', '资产已删除，无需重复操作');
    }
    if (kind === 'recording' && await db.recordingAsset.count({ where: { id: assetId, deletedAt: { not: null } } })) {
      return failure('CONFLICT', '资产已删除，无需重复操作');
    }
    const withFingerprint = { ...preview, fingerprint: fingerprintOf(preview, cleanReason) };
    return { ok: true, data: { preview: withFingerprint, previewToken: encodePreviewToken(withFingerprint, cleanReason) } };
  } catch {
    return failure('INTERNAL', '读取删除影响失败');
  }
}

export async function confirmAssetDeletion(
  db: PrismaClient,
  input: { kind: DeletableAssetKind; assetId: string; reason: string; previewToken: string; confirmation?: string },
): Promise<AssetDeletionResult<ConfirmDeletionData>> {
  if (input.confirmation !== '确认删除') return failure('VALIDATION', '需要输入“确认删除”才能执行二次确认');
  const token = decodePreviewToken(input.previewToken);
  if (!token || token.kind !== input.kind || token.assetId !== input.assetId || token.reason !== input.reason.trim()) {
    return failure('CONFLICT', '删除预览已过期或与当前操作不匹配，请重新预览');
  }
  try {
    return await db.$transaction(async (tx) => {
      const preview = await inspectAsset(tx, input.kind, input.assetId);
      if (!preview) return failure('NOT_FOUND', '资产不存在');
      const deleted = input.kind === 'audio'
        ? await tx.audioAsset.findUnique({ where: { id: input.assetId }, select: { deletedAt: true } })
        : await tx.recordingAsset.findUnique({ where: { id: input.assetId }, select: { deletedAt: true } });
      if (deleted?.deletedAt) return failure('CONFLICT', '资产已删除，无需重复操作');
      // 预览后任何新引用/子记录都会改变 fingerprint，必须重新预览。
      if (fingerprintOf(preview, input.reason) !== token.fingerprint) {
        return failure('CONFLICT', '资产引用或关联记录已变化，请重新预览', preview.references);
      }
      if (preview.references.length) {
        return failure('PRECONDITION', `资源仍被 ${preview.references.length} 条证据/诊断/材料/计划记录引用，不能删除`, preview.references);
      }
      const data = { deletedAt: new Date(), deletionReason: input.reason.trim() };
      const result = input.kind === 'audio'
        ? await tx.audioAsset.updateMany({ where: { id: input.assetId, deletedAt: null }, data })
        : await tx.recordingAsset.updateMany({ where: { id: input.assetId, deletedAt: null }, data });
      if (result.count !== 1) return failure('CONFLICT', '资产状态已变化，请重新预览');
      return {
        ok: true as const,
        data: {
          id: input.assetId,
          deletedAt: data.deletedAt.toISOString(),
          retainedChildRecords: Object.values(preview.affected).reduce((sum, count) => sum + count, 0),
          retainedReferences: 0,
        },
      };
    });
  } catch {
    return failure('INTERNAL', '删除事务失败，未做任何修改');
  }
}
