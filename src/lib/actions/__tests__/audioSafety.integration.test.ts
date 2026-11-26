/** v2.7.1 P0-6：tombstone、引用保护、活跃查询/播放与统一上传的隔离集成测试。 */

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { AUDIO_MAX_UPLOAD_BYTES, RECORDING_MAX_BYTES } from '@/lib/constants';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb();
const actions = await import('@/lib/actions/listening');
const queries = await import('@/lib/queries/listening');
const { GET: getAudio } = await import('@/app/api/audio/[id]/route');
const { GET: getRecording } = await import('@/app/api/recordings/[id]/route');
const { POST: uploadAudioRoute } = await import('@/app/api/upload-audio/route');
const { POST: uploadRecordingRoute } = await import('@/app/api/upload-recording/route');
const { writeUploadedFile } = await import('@/lib/storage');

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

function wav(): Buffer {
  const bytes = Buffer.alloc(8044);
  bytes.write('RIFF'); bytes.writeUInt32LE(8036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(8000, 40);
  return bytes;
}
function webm(seconds = 1): Buffer {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(seconds);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from('webm')]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x90, 0x15, 0x49, 0xa9, 0x66, 0x8b, 0x44, 0x89, 0x88, ...duration]),
  ]);
}
async function audio(title = 'test audio') {
  return prisma.audioAsset.create({ data: { title, filePath: `${randomBytes(8).toString('hex')}.wav`, mimeType: 'audio/wav' } });
}
async function preview(kind: 'audio' | 'recording', assetId: string, reason = '不再使用') {
  const result = await actions.previewAudioAssetDeletionAction({ kind, assetId, reason });
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.data;
}
async function confirm(data: Awaited<ReturnType<typeof preview>>, kind: 'audio' | 'recording', confirmation = '确认删除') {
  return actions.confirmAssetDeletionAction({
    kind, assetId: data.preview.assetId, reason: '不再使用', confirmation, previewToken: data.previewToken,
  });
}

describe('资产 tombstone 删除', () => {
  it('预览零写入；缺少二次确认不删除；确认只标记父资产并保留全部子行', async () => {
    const asset = await audio('保留子行');
    const exercise = await prisma.listeningExercise.create({ data: { audioAssetId: asset.id, mode: 'DICTATION', title: 'exercise' } });
    const attempt = await prisma.listeningAttempt.create({ data: { exerciseId: exercise.id, status: 'SUBMITTED' } });
    const error = await prisma.listeningError.create({ data: { attemptId: attempt.id, errorType: 'UNKNOWN' } });
    const transcript = await prisma.transcript.create({ data: { audioAssetId: asset.id, segments: { create: { seq: 0, text: 'hello' } } } });
    const session = await prisma.speakingSession.create({ data: {} });
    const turn = await prisma.speakingTurn.create({ data: { sessionId: session.id, role: 'USER', seq: 0, transcriptId: transcript.id } });

    const data = await preview('audio', asset.id);
    expect(data.preview.affected).toMatchObject({ listeningExercises: 1, listeningAttempts: 1, listeningErrors: 1, transcripts: 1, transcriptSegments: 1, speakingTurns: 1 });
    expect((await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
    expect((await confirm(data, 'audio', '')).ok).toBe(false);
    const result = await confirm(data, 'audio');
    expect(result.ok).toBe(true);
    const row = await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletionReason).toBe('不再使用');
    expect(row.filePath).toBe(asset.filePath);
    expect(await prisma.listeningExercise.count({ where: { id: exercise.id } })).toBe(1);
    expect(await prisma.listeningAttempt.count({ where: { id: attempt.id } })).toBe(1);
    expect(await prisma.listeningError.count({ where: { id: error.id } })).toBe(1);
    expect(await prisma.transcript.count({ where: { id: transcript.id } })).toBe(1);
    expect(await prisma.transcriptSegment.count({ where: { transcriptId: transcript.id } })).toBe(1);
    expect(await prisma.speakingTurn.count({ where: { id: turn.id } })).toBe(1);
    expect(await queries.getAudioAsset(asset.id)).toBeNull();
    expect(await queries.listListeningExercises()).toEqual([]);
  });

  it('被 ListeningAttempt 关联的 EvidenceRecord 引用时返回 PRECONDITION 和证据 ID', async () => {
    const asset = await audio('证据引用');
    const exercise = await prisma.listeningExercise.create({ data: { audioAssetId: asset.id, mode: 'DETAIL', title: 'evidence exercise' } });
    const evidence = await prisma.evidenceRecord.create({ data: { skill: 'LISTENING', evidenceType: 'BASELINE', outputText: '证据' } });
    await prisma.listeningAttempt.create({ data: { exerciseId: exercise.id, evidenceId: evidence.id, status: 'SUBMITTED' } });
    const data = await preview('audio', asset.id);
    expect(data.preview.references).toContainEqual({ model: 'EvidenceRecord', id: evidence.id });
    const result = await confirm(data, 'audio');
    expect(result).toMatchObject({ ok: false, code: 'PRECONDITION' });
    expect(result).toHaveProperty('references', expect.arrayContaining([{ model: 'EvidenceRecord', id: evidence.id }]));
    expect((await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
  });

  it('EvidenceAttachment、LearningOutput 与 AIUsageRecord 的文本引用阻止删除', async () => {
    const asset = await audio('跨域引用');
    const attachment = await prisma.evidenceAttachment.create({ data: {
      fileUri: `storage/uploads/${asset.filePath}`, evidenceType: 'RECORDING', linkedEntity: 'STUDY_RECORD', linkedId: 'record-1',
    } });
    const output = await prisma.learningOutput.create({ data: { outputType: 'RECORDING', uri: `storage/uploads/${asset.filePath}` } });
    const usage = await prisma.aIUsageRecord.create({ data: {
      toolName: 'transcribe', assistanceLevel: 'A1', actionType: 'OTHER', inputRef: `audioAssetId=${asset.id}`,
    } });
    const data = await preview('audio', asset.id);
    expect(data.preview.references).toEqual(expect.arrayContaining([
      { model: 'EvidenceAttachment', id: attachment.id },
      { model: 'LearningOutput', id: output.id },
      { model: 'AIUsageRecord', id: usage.id },
    ]));
    expect(await confirm(data, 'audio')).toMatchObject({ ok: false, code: 'PRECONDITION' });
  });

  it('DiagnosticAttempt/DiagnosticAsset 的 ID 或路径引用也阻止删除', async () => {
    const asset = await audio('诊断引用');
    const blueprint = await prisma.diagnosticBlueprint.create({ data: { code: `bp-${asset.id}`, version: 'v1', title: 'bp' } });
    const item = await prisma.diagnosticItem.create({ data: {
      blueprintId: blueprint.id, itemCode: `item-${asset.id}`, skill: 'SPEAKING_PRODUCTION', subskill: 'FLUENCY',
      targetLevelMin: 'A1', targetLevelMax: 'B1', taskType: 'OPEN_SPEAKING', sourceType: 'VERIFIED', prompt: 'speak',
    } });
    const session = await prisma.diagnosticSession.create({ data: { blueprintId: blueprint.id } });
    const attempt = await prisma.diagnosticAttempt.create({ data: { sessionId: session.id, itemId: item.id, sequence: 0, responseJson: JSON.stringify({ audioAssetId: asset.id }) } });
    const diagnosticAsset = await prisma.diagnosticAsset.create({ data: { attemptId: attempt.id, kind: 'AUDIO', storagePath: asset.filePath } });
    const data = await preview('audio', asset.id);
    expect(data.preview.references).toEqual(expect.arrayContaining([
      { model: 'DiagnosticAttempt', id: attempt.id }, { model: 'DiagnosticAsset', id: diagnosticAsset.id },
    ]));
    expect((await confirm(data, 'audio')).ok).toBe(false);
  });

  it('预览后新增 EvidenceRecord 会使令牌失效，返回 CONFLICT 且不删除', async () => {
    const asset = await audio('过期预览');
    const data = await preview('audio', asset.id);
    const evidence = await prisma.evidenceRecord.create({ data: { skill: 'LISTENING', evidenceType: 'BASELINE', note: `audioAssetId=${asset.id}` } });
    const result = await confirm(data, 'audio');
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(result).toHaveProperty('references', expect.arrayContaining([{ model: 'EvidenceRecord', id: evidence.id }]));
    expect((await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
  });

  it('伪造令牌、跨资产令牌和错误确认文本均不能删除', async () => {
    const first = await audio('first');
    const second = await audio('second');
    const data = await preview('audio', first.id);
    expect((await confirm(data, 'audio', '删除')).ok).toBe(false);
    expect((await actions.confirmAssetDeletionAction({ kind: 'audio', assetId: second.id, reason: '不再使用', confirmation: '确认删除', previewToken: data.previewToken })).ok).toBe(false);
    expect((await actions.confirmAssetDeletionAction({ kind: 'audio', assetId: first.id, reason: '不再使用', confirmation: '确认删除', previewToken: `${data.previewToken}x` })).ok).toBe(false);
    expect(
      await prisma.audioAsset.count({
        where: { id: { in: [first.id, second.id] }, deletedAt: { not: null } },
      }),
    ).toBe(0);
  });

  it('录音保留 turn/transcript/ASR/技术检查；SpeechEvaluation 引用拒绝删除', async () => {
    const recording = await prisma.recordingAsset.create({ data: { filePath: 'recording.webm', mimeType: 'audio/webm' } });
    const session = await prisma.speakingSession.create({ data: {} });
    const transcript = await prisma.transcript.create({ data: { recordingAssetId: recording.id, segments: { create: { seq: 0, text: 'hello' } } } });
    const turn = await prisma.speakingTurn.create({ data: { sessionId: session.id, role: 'USER', seq: 0, recordingAssetId: recording.id, transcriptId: transcript.id } });
    await prisma.aSRResult.create({ data: { recordingAssetId: recording.id, provider: 'local', model: 'test', status: 'SUCCEEDED' } });
    await prisma.audioTechnicalCheck.create({ data: { recordingAssetId: recording.id, status: 'OK' } });
    const data = await preview('recording', recording.id);
    expect(data.preview.affected).toMatchObject({ speakingTurns: 1, transcripts: 1, transcriptSegments: 1, asrResults: 1, audioTechnicalChecks: 1 });
    expect((await confirm(data, 'recording')).ok).toBe(true);
    expect(await prisma.speakingTurn.count({ where: { id: turn.id } })).toBe(1);
    expect(await prisma.transcript.count({ where: { id: transcript.id } })).toBe(1);

    const referenced = await prisma.recordingAsset.create({ data: { filePath: 'referenced.webm' } });
    const evaluation = await prisma.speechEvaluation.create({ data: { recordingAssetId: referenced.id, rubricVersion: 'v1', dimensionsJson: '{}' } });
    const evaluationPreview = await preview('recording', referenced.id);
    expect(evaluationPreview.preview.references).toContainEqual({ model: 'SpeechEvaluation', id: evaluation.id });
    expect(await confirm(evaluationPreview, 'recording')).toMatchObject({ ok: false, code: 'PRECONDITION' });
  });
});

describe('活跃查询与播放 API', () => {
  it('未关联会话的录音也有活跃列表和删除入口', async () => {
    const recording = await prisma.recordingAsset.create({ data: { filePath: 'standalone.webm', mimeType: 'audio/webm' } });
    expect((await queries.listUnassignedRecordings()).map((row) => row.id)).toContain(recording.id);
    expect((await confirm(await preview('recording', recording.id), 'recording')).ok).toBe(true);
    expect((await queries.listUnassignedRecordings()).map((row) => row.id)).not.toContain(recording.id);
    expect(await prisma.recordingAsset.count({ where: { id: recording.id } })).toBe(1);
  });

  it('删除后列表/详情/转写/录音列表排除 tombstone，文件仍存在', async () => {
    const stored = writeUploadedFile(wav(), 'wav');
    const asset = await prisma.audioAsset.create({ data: { title: '播放测试', filePath: stored.relativePath, mimeType: 'audio/wav' } });
    const transcript = await prisma.transcript.create({ data: { audioAssetId: asset.id, segments: { create: { seq: 0, text: 'hello' } } } });
    const recording = await prisma.recordingAsset.create({ data: { filePath: stored.relativePath, mimeType: 'audio/wav' } });
    const session = await prisma.speakingSession.create({ data: {} });
    await prisma.recordingAsset.update({ where: { id: recording.id }, data: { sessionId: session.id } });
    try {
      expect((await queries.listAudioAssets()).some((row) => row.id === asset.id)).toBe(true);
      const before = await getAudio(new Request(`http://local/api/audio/${asset.id}`, { headers: { range: 'bytes=0-9' } }), { params: Promise.resolve({ id: asset.id }) });
      expect(before.status).toBe(206);
      expect(before.headers.get('content-range')).toBe(`bytes 0-9/${stored.sizeBytes}`);
      expect(new Uint8Array(await before.arrayBuffer())).toHaveLength(10);
      const invalidRange = await getAudio(new Request(`http://local/api/audio/${asset.id}`, { headers: { range: 'bytes=999999-' } }), { params: Promise.resolve({ id: asset.id }) });
      expect(invalidRange.status).toBe(416);

      expect((await confirm(await preview('audio', asset.id), 'audio')).ok).toBe(true);
      expect((await confirm(await preview('recording', recording.id), 'recording')).ok).toBe(true);
      expect((await queries.listAudioAssets()).some((row) => row.id === asset.id)).toBe(false);
      expect(await queries.getAudioAsset(asset.id)).toBeNull();
      expect(await queries.listTranscriptsForAudio(asset.id)).toEqual([]);
      const sessions = await queries.listSpeakingSessions();
      expect(sessions.find((row) => row.id === session.id)?.recordings).toEqual([]);
      expect((await getAudio(new Request(`http://local/api/audio/${asset.id}`), { params: Promise.resolve({ id: asset.id }) })).status).toBe(404);
      expect((await getRecording(new Request(`http://local/api/recordings/${recording.id}`), { params: Promise.resolve({ id: recording.id }) })).status).toBe(404);
      expect(await prisma.transcript.count({ where: { id: transcript.id } })).toBe(1);
      expect(stored.absolutePath).toContain('/storage/uploads/');
    } finally {
      rmSync(stored.absolutePath, { force: true });
    }
  });
});

describe('统一上传入口', () => {
  it('上传 Route 在解析前拒绝超限请求体', async () => {
    const audioResponse = await uploadAudioRoute(new Request('http://local/api/upload-audio', { method: 'POST', headers: { 'content-length': String(AUDIO_MAX_UPLOAD_BYTES + 100_000) } }));
    const recordingResponse = await uploadRecordingRoute(new Request('http://local/api/upload-recording', { method: 'POST', headers: { 'content-length': String(RECORDING_MAX_BYTES + 100_000) } }));
    expect(audioResponse.status).toBe(413);
    expect(recordingResponse.status).toBe(413);
  });

  it('合法 WAV 登记真实容器时长；伪造 MIME/魔数不落盘不建行', async () => {
    const before = await prisma.audioAsset.count();
    const valid = new FormData();
    valid.append('file', new File([Uint8Array.from(wav())], 'valid.wav', { type: 'audio/wav' }));
    valid.append('meta', JSON.stringify({ title: 'valid', durationSec: 1 }));
    const result = await actions.uploadAudioAction(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = await prisma.audioAsset.findUniqueOrThrow({ where: { id: result.data.id } });
      expect(row.durationSec).toBe(1);
      expect(row.mimeType).toBe('audio/wav');
      rmSync(new URL(`../../../../storage/uploads/${row.filePath}`, import.meta.url), { force: true });
    }
    const invalid = new FormData();
    invalid.append('file', new File([Uint8Array.from(Buffer.from('fake audio'))], 'fake.wav', { type: 'audio/wav' }));
    const rejected = await actions.uploadAudioAction(invalid);
    expect(rejected).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await prisma.audioAsset.count()).toBe(before + 1);
  });

  it('录音只接受 WebM，并校验声明/真实时长和会话有效性', async () => {
    const valid = new FormData();
    valid.append('file', new File([Uint8Array.from(webm())], 'recording.webm', { type: 'audio/webm;codecs=opus' }));
    valid.append('durationSec', '1');
    const result = await actions.uploadRecordingAction(valid);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) rmSync(new URL(`../../../../storage/uploads/${result.data.filePath}`, import.meta.url), { force: true });
    const long = new FormData();
    long.append('file', new File([Uint8Array.from(webm(91))], 'recording.webm', { type: 'audio/webm' }));
    long.append('durationSec', '91');
    expect(await actions.uploadRecordingAction(long)).toMatchObject({ ok: false, code: 'VALIDATION' });
    const wrong = new FormData();
    wrong.append('file', new File([Uint8Array.from(wav())], 'recording.wav', { type: 'audio/wav' }));
    expect(await actions.uploadRecordingAction(wrong)).toMatchObject({ ok: false, code: 'VALIDATION' });
    const missingSession = new FormData();
    missingSession.append('file', new File([Uint8Array.from(webm())], 'recording.webm', { type: 'audio/webm' }));
    missingSession.append('sessionId', 'missing');
    expect(await actions.uploadRecordingAction(missingSession)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
