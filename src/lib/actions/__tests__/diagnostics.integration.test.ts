/**
 * v2.4.1 诊断闭环集成测试（独立临时数据库）。
 *
 * 覆盖：分时段暂停/恢复、自适应路由、技术无效不计分、客观题判分、
 * 开放任务待评估、报告暂定、计划草案激活不建 PlanTask、补测与隐私删除。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import * as storage from '@/lib/storage';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma, cleanup } = await createTestDb();
const actions = await import('@/lib/actions/diagnostics');
const { getDiagnosticSessionDetail, getDiagnosticReport } = await import('@/lib/queries/diagnostics');

const ANSWERS: Record<string, string> = {
  'L-KEY-A1': 'B',
  'L-DETAIL-A2': 'B',
  'L-GIST-B1': 'B',
  'L-INFER-B2': 'B',
  'R-SIGN-A1': 'A',
  'R-DETAIL-A2': 'B',
  'R-GIST-B1': 'B',
  'R-REFERENCE-B2': 'B',
  'G-BE-A1': 'A',
  'G-PERFECT-A2': 'C',
  'G-RELATIVE-B1': 'B',
  'G-CONDITIONAL-B2': 'B',
  'V-CONTEXT-A2': 'B',
  'V-COLLOC-B1': 'B',
  'V-FORM-B1': 'growth',
  'S-MAIN-A2': 'C',
  'S-COMPLEX-B2': 'B',
};

const OPEN_ANSWER =
  'I usually get up at seven in the morning and have a simple breakfast with my family. In the afternoon I study English for about one hour, and in the evening I take a short walk before going to bed.';

function webm(seconds: number): Buffer {
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(seconds);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from('webm')]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x90, 0x15, 0x49, 0xa9, 0x66, 0x8b, 0x44, 0x89, 0x88, ...duration]),
  ]);
}

function audioDataUrl(bytes: Buffer): string {
  return `data:audio/webm;base64,${bytes.toString('base64')}`;
}

async function openAudioSession() {
  await prisma.learnerProfile.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: { externalAiConsent: false },
  });
  const blueprint = await prisma.diagnosticBlueprint.create({
    data: { code: `audio-bp-${randomUUID()}`, version: 'v1', title: 'audio test' },
  });
  const item = await prisma.diagnosticItem.create({
    data: {
      blueprintId: blueprint.id,
      itemCode: `audio-item-${randomUUID()}`,
      skill: 'SPEAKING',
      subskill: 'spoken_production',
      targetLevelMin: 'A1',
      targetLevelMax: 'B1',
      taskType: 'OPEN_TASK',
      sourceType: 'RUBRIC',
      prompt: 'Describe your day.',
      rubricJson: JSON.stringify({ dimensions: [{ labelZh: '流利度', descriptor: '连续表达' }] }),
    },
  });
  const session = await prisma.diagnosticSession.create({
    data: {
      blueprintId: blueprint.id,
      status: 'IN_PROGRESS',
      planJson: JSON.stringify({ includeEmlr: false, queue: [item.id], routing: [] }),
      currentItemId: item.id,
    },
  });
  return { sessionId: session.id, itemId: item.id };
}

async function diagnosticWriteCounts(sessionId: string) {
  return {
    attempts: await prisma.diagnosticAttempt.count({ where: { sessionId } }),
    assets: await prisma.diagnosticAsset.count({ where: { attempt: { sessionId } } }),
  };
}

async function removeAudioSession(sessionId: string) {
  if (await prisma.diagnosticSession.findUnique({ where: { id: sessionId }, select: { id: true } })) {
    await actions.deleteDiagnosticSessionAction({ sessionId });
  }
}

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.4.1 初始诊断闭环', () => {
  it('完成多时段诊断、报告、计划确认、补测与删除', async () => {
    const evidenceBefore = await prisma.evidenceRecord.count();
    const taskBefore = await prisma.planTask.count();

    const start = await actions.startDiagnosticAction({
      includeEmlr: false,
      goals: ['GENERAL', 'IELTS'],
      background: {
        examType: 'ACADEMIC',
        weeklyMinutes: 300,
        recordingConsent: true,
        externalAiConsent: false,
        selfWeakness: '听力最弱',
      },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const sessionId = start.data.sessionId;

    const detail = await getDiagnosticSessionDetail(sessionId);
    expect(detail?.status).toBe('IN_PROGRESS');
    expect(detail?.currentItem?.itemCode).toBe('L-DETAIL-A2');
    expect(detail?.currentItem?.transcript).toContain('main hall');

    // 第一题答对：自适应插入更难平行题
    const first = await actions.submitAttemptAction({
      sessionId,
      itemId: detail!.currentItem!.id,
      responseText: 'B',
      timeSpentSec: 20,
      clientRequestId: 'diag-first',
    });
    expect(first.ok).toBe(true);
    const afterFirst = await getDiagnosticSessionDetail(sessionId);
    expect(afterFirst?.currentItem?.itemCode).toBe('L-GIST-B1');
    expect(afterFirst?.routing[0]?.rationale).toContain('答对');

    // 幂等：相同 clientRequestId 不重复落库
    const attemptsBefore = await prisma.diagnosticAttempt.count({ where: { sessionId } });
    const duplicate = await actions.submitAttemptAction({
      sessionId,
      itemId: detail!.currentItem!.id,
      responseText: 'B',
      timeSpentSec: 20,
      clientRequestId: 'diag-first',
    });
    expect(duplicate.ok).toBe(true);
    expect(await prisma.diagnosticAttempt.count({ where: { sessionId } })).toBe(attemptsBefore);

    // 暂停后拒绝提交，恢复后继续
    const paused = await actions.pauseDiagnosticAction({ sessionId, paused: true });
    expect(paused.ok).toBe(true);
    const blocked = await actions.submitAttemptAction({
      sessionId,
      itemId: afterFirst!.currentItem!.id,
      responseText: 'B',
    });
    expect(blocked.ok).toBe(false);
    const resumed = await actions.pauseDiagnosticAction({ sessionId, paused: false });
    expect(resumed.ok).toBe(true);

    let invalidDone = false;
    for (let step = 0; step < 30; step += 1) {
      const state = await getDiagnosticSessionDetail(sessionId);
      const item = state?.currentItem;
      if (!item) break;

      // 口语发声任务第一次模拟设备失败
      if (item.itemCode === 'SP-PROD-A2' && !invalidDone) {
        invalidDone = true;
        const invalid = await actions.submitAttemptAction({
          sessionId,
          itemId: item.id,
          responseText: '',
          technicalFailed: true,
          technicalReason: '测试：麦克风失败',
          clientRequestId: `invalid-${step}`,
        });
        expect(invalid.ok).toBe(true);
        if (invalid.ok) expect(invalid.data.status).toBe('INVALID');
        continue;
      }

      const text = ANSWERS[item.itemCode] ?? OPEN_ANSWER;
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId: item.id,
        responseText: text,
        timeSpentSec: 30,
        clientRequestId: `step-${step}`,
      });
      expect(result.ok).toBe(true);
    }

    expect(invalidDone).toBe(true);

    const attempts = await prisma.diagnosticAttempt.findMany({ where: { sessionId } });
    const invalidAttempts = attempts.filter((attempt) => attempt.status === 'INVALID');
    expect(invalidAttempts).toHaveLength(1);
    expect(invalidAttempts[0].evidenceId).toBeNull();
    expect(invalidAttempts[0].score).toBeNull();

    // 技术无效的题目被重新排队并最终补做成功
    const speakingProd = attempts.filter((attempt) => attempt.itemId === invalidAttempts[0].itemId);
    expect(speakingProd.length).toBe(2);
    expect(speakingProd.some((attempt) => attempt.status === 'NEEDS_REVIEW')).toBe(true);

    // 每个客观技能最多 2 题（基础题 + 自适应平行题），不会连锁加题
    const scoredWithSkill = await prisma.diagnosticAttempt.findMany({
      where: { sessionId, status: { not: 'INVALID' } },
      select: { item: { select: { skill: true } } },
    });
    const skillCounts = new Map<string, number>();
    for (const row of scoredWithSkill) {
      skillCounts.set(row.item.skill, (skillCounts.get(row.item.skill) ?? 0) + 1);
    }
    for (const skill of ['LISTENING', 'READING', 'GRAMMAR', 'VOCABULARY', 'SENTENCE_STRUCTURE']) {
      expect(skillCounts.get(skill) ?? 0).toBeLessThanOrEqual(2);
    }

    // 开放任务在未启用外部 AI 时保持待评估，不用模拟结果定级
    const pending = attempts.filter((attempt) => attempt.status === 'NEEDS_REVIEW');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(await prisma.assessmentResult.count({ where: { attempt: { sessionId } } })).toBe(0);

    const finalize = await actions.finalizeDiagnosticAction({ sessionId });
    expect(finalize.ok).toBe(true);
    if (!finalize.ok) return;
    const reportId = finalize.data.reportId;
    expect(finalize.data.provisional).toBe(true);

    const report = await getDiagnosticReport(reportId);
    expect(report?.status).toBe('PROVISIONAL');
    expect(report?.summary).toContain('不取平均');
    expect(report?.snapshots.map((snapshot) => snapshot.skill)).toEqual(
      expect.arrayContaining(['LISTENING', 'READING', 'SPEAKING', 'WRITING', 'GRAMMAR', 'VOCABULARY', 'SENTENCE_STRUCTURE']),
    );

    // 技术无效不作为能力不足证据：听力/阅读已有有效证据
    const listening = report?.snapshots.find((snapshot) => snapshot.skill === 'LISTENING');
    const reading = report?.snapshots.find((snapshot) => snapshot.skill === 'READING');
    expect(listening?.evidenceCount).toBeGreaterThan(0);
    expect(reading?.evidenceCount).toBeGreaterThan(0);
    const speaking = report?.snapshots.find((snapshot) => snapshot.skill === 'SPEAKING');
    expect(speaking?.evidenceCount).toBe(0);
    expect(speaking?.needsFollowUp).toBe(true);

    // 计划草案保存后仍为 DRAFT，只有 Planner Preview/Confirm 才能写正式计划
    expect(report?.proposal?.status).toBe('DRAFT');
    expect(report?.proposal?.budget?.weeklyMinutes).toBeGreaterThan(0);
    const confirmDraft = await actions.confirmDiagnosticPlanAction({ proposalId: report!.proposal!.id });
    expect(confirmDraft.ok).toBe(true);
    if (confirmDraft.ok) expect(confirmDraft.data.status).toBe('DRAFT');
    const proposal = await prisma.planProposal.findUnique({ where: { id: report!.proposal!.id } });
    expect(proposal?.status).toBe('DRAFT');
    expect(proposal?.activatedAt).toBeNull();
    expect(await prisma.planTask.count()).toBe(taskBefore);
    expect(await prisma.planVersion.count()).toBe(0);

    // 证据确实增加（仅有效尝试），且与 attempt 一对一
    expect(await prisma.evidenceRecord.count()).toBeGreaterThan(evidenceBefore);
    const linked = await prisma.diagnosticAttempt.count({ where: { sessionId, evidenceId: { not: null } } });
    expect(linked).toBeGreaterThan(0);

    // 补测创建新会话，旧报告保留
    const retest = await actions.retestAction({ reportId });
    expect(retest.ok).toBe(true);
    expect(await prisma.placementReport.findUnique({ where: { id: reportId } })).not.toBeNull();
    if (retest.ok) {
      const retestDetail = await getDiagnosticSessionDetail(retest.data.sessionId);
      const item = retestDetail?.currentItem;
      expect(item).not.toBeNull();
      if (item) {
        const answer = await prisma.diagnosticItem.findUniqueOrThrow({ where: { id: item.id } });
        const submitted = await actions.submitAttemptAction({
          sessionId: retest.data.sessionId,
          itemId: item.id,
          responseText: answer.correctAnswer ?? OPEN_ANSWER,
          timeSpentSec: 20,
          clientRequestId: 'retest-finalize',
        });
        expect(submitted.ok).toBe(true);
        const finalized = await actions.finalizeDiagnosticAction({ sessionId: retest.data.sessionId });
        expect(finalized.ok).toBe(true);
        if (finalized.ok) {
          expect(finalized.data.reportId).not.toBe(reportId);
          expect(await prisma.placementReport.findUniqueOrThrow({ where: { id: reportId } })).toMatchObject({
            status: 'SUPERSEDED',
            supersededById: finalized.data.reportId,
          });
          expect(await prisma.placementReport.findUniqueOrThrow({ where: { id: finalized.data.reportId } })).toMatchObject({
            status: 'PROVISIONAL',
          });
        }
      }
    }

    // 隐私删除：删除会话同时移除其证据与原始作答
    const evidenceIds = (
      await prisma.diagnosticAttempt.findMany({
        where: { sessionId },
        select: { evidenceId: true },
      })
    )
      .map((row) => row.evidenceId)
      .filter((id): id is string => Boolean(id));

    const deleted = await actions.deleteDiagnosticSessionAction({ sessionId });
    expect(deleted.ok).toBe(true);
    expect(await prisma.diagnosticSession.findUnique({ where: { id: sessionId } })).toBeNull();
    if (evidenceIds.length > 0) {
      expect(
        await prisma.evidenceRecord.count({ where: { id: { in: evidenceIds } } }),
      ).toBe(0);
    }
  });
});

describe('P0-6 诊断录音统一音频安全入口', () => {
  it('伪造容器、非 WebM 前缀和非法 base64 均返回 VALIDATION，且不留下 attempt/asset/evidence', async () => {
    const { sessionId, itemId } = await openAudioSession();
    const evidenceBefore = await prisma.evidenceRecord.count();
    const bytes = webm(1.6);
    const invalidUrls = [
      audioDataUrl(Buffer.from('this is not a WebM container')),
      `data:audio/wav;base64,${bytes.toString('base64')}`,
      'data:audio/webm;base64,%%%not-base64%%%',
      'data:audio/webm;base64,YQ',
      'data:audio/webm;base64,YR==',
      '',
    ];
    try {
      for (const [index, url] of invalidUrls.entries()) {
        const result = await actions.submitAttemptAction({
          sessionId,
          itemId,
          responseText: OPEN_ANSWER,
          audioDataUrl: url,
          audioMime: 'audio/webm',
          audioDurationSec: 2,
          clientRequestId: `invalid-audio-${index}`,
        });
        expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
        expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 0, assets: 0 });
        expect(await prisma.evidenceRecord.count()).toBe(evidenceBefore);
      }
    } finally {
      await removeAudioSession(sessionId);
    }
  });

  it('声明时长与真实容器不符时在写入前拒绝，不留下 Pending 记录', async () => {
    const { sessionId, itemId } = await openAudioSession();
    const evidenceBefore = await prisma.evidenceRecord.count();
    try {
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId,
        responseText: '',
        audioDataUrl: audioDataUrl(webm(1.6)),
        audioMime: 'audio/webm',
        audioDurationSec: 5,
      });
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 0, assets: 0 });
      expect(await prisma.evidenceRecord.count()).toBe(evidenceBefore);
    } finally {
      await removeAudioSession(sessionId);
    }
  });

  it('真实 WebM 落盘并保存相对路径、真实大小、sha256 和四舍五入时长；隐私删除同步清理文件', async () => {
    const { sessionId, itemId } = await openAudioSession();
    const bytes = webm(1.6);
    const evidenceBefore = await prisma.evidenceRecord.count();
    let relativePath: string | undefined;
    try {
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId,
        responseText: '',
        audioDataUrl: audioDataUrl(bytes),
        audioMime: 'audio/webm;codecs=opus',
        audioDurationSec: 2,
      });
      expect(result).toMatchObject({ ok: true, data: { status: 'NEEDS_REVIEW' } });
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 1, assets: 1 });
      expect(await prisma.evidenceRecord.count()).toBe(evidenceBefore);

      const asset = await prisma.diagnosticAsset.findFirstOrThrow({ where: { attempt: { sessionId } } });
      relativePath = asset.storagePath ?? undefined;
      expect(relativePath).toMatch(/^[^/\\]+\.webm$/);
      expect(relativePath).not.toContain('data:');
      expect(asset).toMatchObject({
        kind: 'AUDIO',
        mimeType: 'audio/webm',
        sizeBytes: bytes.byteLength,
        sha256: storage.sha256Hex(bytes),
        durationSec: 2,
      });
      const absolutePath = storage.resolveUploadPath(relativePath!);
      expect(readFileSync(absolutePath)).toEqual(bytes);

      const deleted = await actions.deleteDiagnosticSessionAction({ sessionId });
      expect(deleted.ok).toBe(true);
      expect(existsSync(absolutePath)).toBe(false);
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 0, assets: 0 });
    } finally {
      await removeAudioSession(sessionId);
      if (relativePath) rmSync(join(storage.uploadsDir(), relativePath), { force: true });
    }
  });

  it('无音频的开放任务仍按原逻辑保存待评估作答，不产生资产', async () => {
    const { sessionId, itemId } = await openAudioSession();
    try {
      const result = await actions.submitAttemptAction({ sessionId, itemId, responseText: OPEN_ANSWER });
      expect(result).toMatchObject({ ok: true, data: { status: 'NEEDS_REVIEW' } });
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 1, assets: 0 });
    } finally {
      await removeAudioSession(sessionId);
    }
  });

  it('存储写入失败返回 INTERNAL，且不产生半截 attempt/asset', async () => {
    const { sessionId, itemId } = await openAudioSession();
    const write = vi.spyOn(storage, 'writeUploadedFile').mockImplementationOnce(() => {
      throw new Error('simulated disk failure');
    });
    try {
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId,
        responseText: '',
        audioDataUrl: audioDataUrl(webm(1)),
        audioDurationSec: 1,
      });
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL' });
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 0, assets: 0 });
    } finally {
      write.mockRestore();
      await removeAudioSession(sessionId);
    }
  });

  it('Attempt/Asset 事务失败时回滚数据库并清理本次物理文件', async () => {
    const { sessionId, itemId } = await openAudioSession();
    const originalWrite = storage.writeUploadedFile;
    let writtenPath: string | undefined;
    const write = vi.spyOn(storage, 'writeUploadedFile').mockImplementationOnce((buffer, extension) => {
      const stored = originalWrite(buffer, extension);
      writtenPath = stored.absolutePath;
      return stored;
    });
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER diagnostic_audio_insert_failure BEFORE INSERT ON "DiagnosticAsset" BEGIN SELECT RAISE(ABORT, \'simulated asset failure\'); END',
    );
    try {
      const result = await actions.submitAttemptAction({
        sessionId,
        itemId,
        responseText: '',
        audioDataUrl: audioDataUrl(webm(1)),
        audioDurationSec: 1,
      });
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL' });
      expect(await diagnosticWriteCounts(sessionId)).toEqual({ attempts: 0, assets: 0 });
      expect(writtenPath).toBeDefined();
      expect(existsSync(writtenPath!)).toBe(false);
    } finally {
      write.mockRestore();
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS diagnostic_audio_insert_failure');
      await removeAudioSession(sessionId);
      if (writtenPath) rmSync(writtenPath, { force: true });
    }
  });
});