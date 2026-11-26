import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '@/lib/__tests__/helpers/testDb';

// 显式使用 /tmp 隔离库；globalSetup 另外校验真实 prisma/dev.db 未变化。
const { prisma, cleanup } = await createTestDb({ temporaryRoot: '/tmp' });
const { listSpeakingPrompts, listSpeakingSessions } = await import('@/lib/queries/listening');

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeAll(async () => {
  await prisma.speakingPrompt.createMany({
    data: [
      {
        id: 'prompt-active',
        taskType: 'TOPIC_MONOLOGUE',
        title: 'active prompt',
        prompt: 'Describe a useful skill.',
        active: true,
        createdAt: new Date('2026-11-20T00:00:00.000Z'),
      },
      {
        id: 'prompt-inactive',
        taskType: 'SHORT_ANSWER',
        title: 'inactive prompt',
        prompt: 'Give a short answer.',
        active: false,
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
      },
    ],
  });
  await prisma.speakingSession.createMany({
    data: [
      {
        id: 'session-active',
        promptId: 'prompt-active',
        mode: 'PRACTICE',
        status: 'COMPLETED',
        createdAt: new Date('2026-11-22T00:00:00.000Z'),
      },
      {
        id: 'session-inactive-prompt',
        promptId: 'prompt-inactive',
        mode: 'PRACTICE',
        status: 'COMPLETED',
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
      },
    ],
  });
  await prisma.recordingAsset.createMany({
    data: [
      { id: 'recording-live', sessionId: 'session-active', filePath: 'recordings/live.webm', takeNumber: 1 },
      {
        id: 'recording-deleted',
        sessionId: 'session-active',
        filePath: 'recordings/deleted.webm',
        takeNumber: 2,
        deletedAt: new Date('2026-11-23T00:00:00.000Z'),
        deletionReason: 'USER_DELETE',
      },
    ],
  });
  await prisma.audioAsset.createMany({
    data: [
      { id: 'audio-live', title: 'live audio', filePath: 'audio/live.mp3' },
      {
        id: 'audio-deleted',
        title: 'deleted audio',
        filePath: 'audio/deleted.mp3',
        deletedAt: new Date('2026-11-23T00:00:00.000Z'),
        deletionReason: 'USER_DELETE',
      },
    ],
  });
  await prisma.transcript.createMany({
    data: [
      { id: 'transcript-live-audio', audioAssetId: 'audio-live' },
      { id: 'transcript-deleted-audio', audioAssetId: 'audio-deleted' },
      { id: 'transcript-live-recording', recordingAssetId: 'recording-live' },
      { id: 'transcript-deleted-recording', recordingAssetId: 'recording-deleted' },
      { id: 'transcript-live-audio-deleted-recording', audioAssetId: 'audio-live', recordingAssetId: 'recording-deleted' },
      { id: 'transcript-deleted-audio-live-recording', audioAssetId: 'audio-deleted', recordingAssetId: 'recording-live' },
      { id: 'transcript-standalone' },
    ],
  });
  await prisma.speakingTurn.createMany({
    data: [
      { id: 'turn-text', sessionId: 'session-active', role: 'USER', seq: 1, text: 'plain text' },
      { id: 'turn-live-recording', sessionId: 'session-active', role: 'USER', seq: 2, text: 'live recording', recordingAssetId: 'recording-live' },
      { id: 'turn-deleted-recording', sessionId: 'session-active', role: 'USER', seq: 3, text: 'deleted recording', recordingAssetId: 'recording-deleted' },
      { id: 'turn-live-audio', sessionId: 'session-active', role: 'AI', seq: 4, text: 'live audio transcript', transcriptId: 'transcript-live-audio' },
      { id: 'turn-deleted-audio', sessionId: 'session-active', role: 'AI', seq: 5, text: 'deleted audio transcript', transcriptId: 'transcript-deleted-audio' },
      { id: 'turn-live-recording-transcript', sessionId: 'session-active', role: 'AI', seq: 6, text: 'live recording transcript', transcriptId: 'transcript-live-recording' },
      { id: 'turn-deleted-recording-transcript', sessionId: 'session-active', role: 'AI', seq: 7, text: 'deleted recording transcript', transcriptId: 'transcript-deleted-recording' },
      { id: 'turn-mixed-deleted-recording', sessionId: 'session-active', role: 'AI', seq: 8, text: 'one deleted parent', transcriptId: 'transcript-live-audio-deleted-recording' },
      { id: 'turn-mixed-deleted-audio', sessionId: 'session-active', role: 'AI', seq: 9, text: 'one deleted parent', transcriptId: 'transcript-deleted-audio-live-recording' },
      { id: 'turn-standalone-transcript', sessionId: 'session-active', role: 'AI', seq: 10, text: 'standalone transcript', transcriptId: 'transcript-standalone' },
      { id: 'turn-history', sessionId: 'session-inactive-prompt', role: 'USER', seq: 1, text: 'historical turn' },
    ],
  });
});

describe('口语查询的 active 与 tombstone 边界', () => {
  it('listSpeakingPrompts 只返回 active 题目', async () => {
    await expect(listSpeakingPrompts()).resolves.toEqual([
      { id: 'prompt-active', taskType: 'TOPIC_MONOLOGUE', title: 'active prompt', prompt: 'Describe a useful skill.' },
    ]);
  });

  it('题目停用不隐藏历史会话，已删除录音不出现在会话录音列表', async () => {
    const sessions = await listSpeakingSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((row) => row.id === 'session-inactive-prompt')).toMatchObject({
      promptId: 'prompt-inactive',
      turns: [{ id: 'turn-history', text: 'historical turn' }],
      recordings: [],
    });
    expect(sessions.find((row) => row.id === 'session-active')?.recordings).toEqual([
      { id: 'recording-live', filePath: 'recordings/live.webm', durationSec: null, takeNumber: 1 },
    ]);
  });

  it('过滤直接删除录音及任一类转写父资产已删除的 turn，保留文本和有效资产', async () => {
    const sessions = await listSpeakingSessions();
    const turns = sessions.find((row) => row.id === 'session-active')?.turns ?? [];
    expect(turns.map((turn) => turn.id)).toEqual([
      'turn-text',
      'turn-live-recording',
      'turn-live-audio',
      'turn-live-recording-transcript',
      'turn-standalone-transcript',
    ]);
    // 查询只做软删除过滤，不物理删除子行或证据。
    expect(await prisma.speakingTurn.count({ where: { sessionId: 'session-active' } })).toBe(10);
    expect(await prisma.transcript.count()).toBe(7);
  });
});
