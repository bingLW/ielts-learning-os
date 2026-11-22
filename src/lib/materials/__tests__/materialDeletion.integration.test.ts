/**
 * 材料删除级联的集成测试（T14，AC-09 / G-01 / G-02，真实 Prisma）。
 *
 * 核心断言：删材料时——
 * - 17 张派生表 + `VocabularyItemSource` 归属行全删；
 * - 用户资产保留：`VocabularyItem`（主库词条）、`PlanTask`（已确认任务）、
 *   `EvidenceRecord`（作答证据，这里用普通字符串 evidenceId 模拟，因为它无外键）；
 * - `AICallLog` 账本保留、`materialId` 置 null。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-deletion-${process.pid}-${Date.now()}.db`);

if (!existsSync(sourceDb)) throw new Error(`找不到数据库：${sourceDb}`);
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}?connection_limit=1`;
process.env.AI_CREDENTIALS_SECRET ??= 'ielts-integration-test-secret';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const { prisma } = await import('@/lib/prisma');
await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');

const { deleteMaterialWithCascade } = await import('@/lib/services/materialDeletion');

describe('deleteMaterialWithCascade（AC-09 材料+派生全删、用户资产保留）', () => {
  let materialId = '';
  let itemId = '';
  let planTaskId = '';
  let aiLogId = '';

  beforeAll(async () => {
    const suffix = `${process.pid}-${Date.now()}`;

    // —— 主库词条来源与词条（用户资产，须保留）——
    const source = await prisma.vocabularySource.create({
      data: { sourceType: 'MATERIAL', title: `del-source-${suffix}` },
    });
    const item = await prisma.vocabularyItem.create({
      data: {
        lemma: `delword${suffix}`,
        normalizedLemma: `delword${suffix}`,
        pos: 'n.',
        language: 'en',
        senseKey: 'default',
        definitionZh: '人工释义：保留原样',
        sourceId: source.id,
        sourceRef: 'seed',
      },
    });
    itemId = item.id;

    // —— 计划任务（用户资产，须保留）——
    const stage = await prisma.stage.create({
      data: { code: `DEL_${suffix}`, nameZh: '删除测试阶段', estDaysMin: 1 },
    });
    const planTask = await prisma.planTask.create({
      data: {
        stageId: stage.id,
        planDate: '2026-11-23',
        module: 'READING',
        skill: 'READING',
        plannedMinutes: 30,
      },
    });
    planTaskId = planTask.id;

    // —— 材料 + 派生行 ——
    const material = await prisma.learningMaterial.create({
      data: {
        title: `del-material-${suffix}`,
        format: 'PASTED_TEXT',
        sourceType: 'user_upload',
        language: 'en',
        contentHash: `del-hash-${suffix}`,
        status: 'ready',
        charCount: 40,
        wordCount: 8,
      },
    });
    materialId = material.id;

    await prisma.materialSource.create({
      data: { materialId, sourceType: 'user_upload', rightsConfirmed: true },
    });
    await prisma.materialPermissionRecord.create({
      data: { materialId, action: 'RIGHTS_CONFIRMED', rule: 'user_upload', note: 'seed' },
    });

    const doc = await prisma.parsedDocument.create({
      data: { materialId, version: 1, parserName: 'TXT', parserVersion: 'test-1' },
    });
    const chunk = await prisma.contentChunk.create({
      data: {
        materialId,
        parsedDocumentId: doc.id,
        seq: 1,
        kind: 'PARAGRAPH',
        text: 'Deletion test passage for vocabulary and exercise retention.',
        textHash: 'seed',
        charCount: 58,
        charStart: 0,
        charEnd: 58,
      },
    });
    await prisma.extractionResult.create({
      data: {
        materialId,
        chunkId: chunk.id,
        kind: 'KEYWORD',
        payloadJson: JSON.stringify({ kind: 'KEYWORD', lemma: 'deletion', definition_zh: '删除' }),
        sourceQuote: 'Deletion test passage',
        sourceVerified: true,
        reviewStatus: 'accepted',
      },
    });
    await prisma.vocabularyCandidate.create({
      data: {
        materialId,
        chunkId: chunk.id,
        surfaceForm: 'Deletion',
        lemma: `delword${suffix}`,
        normalizedLemma: `delword${suffix}`,
        pos: 'n.',
        senseKey: 'default',
        definitionZh: '删除',
        contextSentence: 'Deletion test passage',
        contextHash: 'seed',
        reviewStatus: 'accepted',
        syncStatus: 'synced',
        syncedItemId: itemId,
      },
    });
    await prisma.vocabularyItemSource.create({
      data: { itemId, sourceId: source.id, sourceRef: materialId, note: '来自材料（测试）' },
    });

    const set = await prisma.materialExerciseSet.create({
      data: { materialId, title: '删除测试练习', targetSkill: 'READING' },
    });
    const exercise = await prisma.generatedExercise.create({
      data: {
        materialId,
        setId: set.id,
        chunkId: chunk.id,
        type: 'reading_gist',
        targetSkill: 'READING',
        prompt: '主旨？',
        answerJson: JSON.stringify({ options: [{ key: 'A', text: 'x' }], correctKey: 'A', isSingleAnswer: true }),
        explanation: '解释',
        evidenceQuote: 'Deletion test passage',
        dedupeKey: 'seed',
        reviewStatus: 'approved',
      },
    });
    await prisma.exerciseAttempt.create({
      data: {
        materialId,
        setId: set.id,
        exerciseId: exercise.id,
        responseJson: JSON.stringify({ selectedKey: 'A', isCorrect: true, elapsedSec: 5 }),
        isCorrect: true,
        reviewStatusAtAttempt: 'approved',
        evidenceId: 'ev-seed-1',
      },
    });

    await prisma.materialPack.create({
      data: { materialId, estimatedMinutes: 30 },
    });

    const proposal = await prisma.taskProposal.create({
      data: { materialId, baseDate: '2026-11-23', budgetMinutes: 60, totalMinutes: 30, status: 'confirmed' },
    });
    await prisma.taskProposalItem.create({
      data: {
        proposalId: proposal.id,
        module: 'READING',
        targetSkill: 'READING',
        title: '精读',
        suggestedMinutes: 30,
        suggestedDate: '2026-11-23',
        granularity: 30,
        selected: true,
        planTaskId,
      },
    });

    aiLogId = (
      await prisma.aICallLog.create({
        data: {
          provider: 'mock',
          model: 'mock',
          requestId: `req-${suffix}`,
          latencyMs: 1,
          status: 'MOCK',
          materialId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('材料与派生全删、词条/任务/账本保留、归属行删除', async () => {
    const result = await deleteMaterialWithCascade(materialId);
    expect(result).not.toBeNull();

    // 材料主行消失
    expect(await prisma.learningMaterial.count({ where: { id: materialId } })).toBe(0);
    // 派生行消失（抽几个代表）
    expect(await prisma.materialSource.count({ where: { materialId } })).toBe(0);
    expect(await prisma.contentChunk.count({ where: { materialId } })).toBe(0);
    expect(await prisma.extractionResult.count({ where: { materialId } })).toBe(0);
    expect(await prisma.vocabularyCandidate.count({ where: { materialId } })).toBe(0);
    expect(await prisma.exerciseAttempt.count({ where: { materialId } })).toBe(0);
    expect(await prisma.taskProposal.count({ where: { materialId } })).toBe(0);

    // 归属行删除（AC-09 的「只删归属行」）
    expect(await prisma.vocabularyItemSource.count({ where: { sourceRef: materialId } })).toBe(0);

    // 用户资产保留
    expect(await prisma.vocabularyItem.count({ where: { id: itemId } })).toBe(1);
    expect(await prisma.planTask.count({ where: { id: planTaskId } })).toBe(1);

    // 账本保留、materialId 置 null
    expect(await prisma.aICallLog.count({ where: { id: aiLogId } })).toBe(1);
    expect(
      await prisma.aICallLog.findUnique({ where: { id: aiLogId }, select: { materialId: true } }),
    ).toEqual({ materialId: null });

    // 保留计数口径正确
    expect(result?.keptVocabularyItems).toBe(1);
    expect(result?.keptPlanTasks).toBe(1);
    expect(result?.keptAttempts).toBe(1);
    expect(result?.deletedRows).toBeGreaterThan(0);
  });

  it('不存在的材料返回 null（由 action 转 NOT_FOUND）', async () => {
    expect(await deleteMaterialWithCascade('nonexistent-material-id')).toBeNull();
  });
});
