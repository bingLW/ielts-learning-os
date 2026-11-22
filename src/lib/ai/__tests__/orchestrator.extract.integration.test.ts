/**
 * `runAiCompletion()` 抽取的回归闸门（ADR-06）。
 *
 * 为什么单独写这一份：ADR-06 要求抽取后
 * `tutor.integration.test.ts` / `diagnostics.integration.test.ts` 仍然全绿，而这两个文件
 * 在本机被宿主安全中心挡在 SQLite 上（`SQLITE_IOERR_DELETE`，与本批代码无关，也不允许
 * 为环境问题去改它们）。所以这里用**自己的**用例把「抽取没有改变行为」这件事钉住：
 *
 * 1. 预算拦截仍然落 `BLOCKED` 日志，**且 `sessionId` 还在**（抽取前它写在回合事务里，
 *    抽取后写在 `runAiCompletion` 里 —— 若没把 sessionId 带过去，这条就会红）。
 * 2. 拦截时仍然不写 `AILearningTurn`。
 * 3. 材料域调用即使被拦截，`AICallLog.materialId` 也非空（C-08）。
 * 4. 幂等命中时不重复调用、不重复记账（抽取前就在 `runAiTurn` 里，位置未变）。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-orch-${process.pid}-${Date.now()}.db`);

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

const { runAiCompletion, runAiTurn } = await import('@/lib/ai/orchestrator');
const { ensurePromptRegistry } = await import('@/lib/ai/registry');

const BASELINE = 'Last year I go to the beach with my family. We are very happy.';

beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  // 强制 mock 通道；预算默认给足，具体用例再单独收紧
  await prisma.aIEngineSetting.updateMany({
    data: { externalAiEnabled: false, dailyBudgetUsd: 5, monthlyBudgetUsd: 20 },
  });
});

afterAll(async () => {
  if (process.env.MATERIALS_TEST_CLEANUP !== '0') {
    try {
      await rm(workDb, { force: true });
    } catch {
      // 忽略
    }
  }
  await prisma.$disconnect();
}, 60_000);

/** 建一个最小可用的教学会话（只填必填列）。 */
async function createSession(): Promise<string> {
  const session = await prisma.aILearningSession.create({
    data: {
      mode: 'TUTOR',
      skill: 'WRITING',
      objective: '用 5 句话描述一次难忘的旅行',
      targetLevel: 'B1',
      promptTemplateKey: 'ai.tutor.v1',
      provider: 'mock',
      model: 'mock-deterministic',
      baselineText: BASELINE,
    },
    select: { id: true },
  });
  return session.id;
}

/** 把当日预算打到 0 并制造一笔支出 → `evaluateBudget` 判 EXCEEDED。 */
async function exhaustDailyBudget(): Promise<void> {
  await prisma.aIEngineSetting.updateMany({ data: { dailyBudgetUsd: 0 } });
  await prisma.aICallLog.create({
    data: {
      provider: 'mock',
      model: 'mock-deterministic',
      requestId: `it-spend-${Date.now()}`,
      latencyMs: 1,
      estimatedCostUsd: 0.01,
      status: 'MOCK',
    },
  });
}

const META = {
  mode: 'TUTOR' as const,
  skill: 'WRITING' as const,
  objective: '用 5 句话描述一次难忘的旅行',
  targetLevel: 'B1',
  baseline: BASELINE,
};

describe('抽取后行为等价：预算拦截路径', () => {
  it('BLOCKED 日志仍带 sessionId，且不写 AILearningTurn', async () => {
    const sessionId = await createSession();
    await exhaustDailyBudget();

    const result = await runAiTurn({
      prisma,
      sessionId,
      promptKind: 'hint',
      turnKind: 'HINT',
      meta: META,
      clientRequestId: `blocked-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BUDGET_EXCEEDED');
    expect(result.message).toContain('已超出 AI 预算');

    // 抽取前这条是"写在回合事务里"，现在写在 runAiCompletion 里：sessionId 必须还在
    expect(
      await prisma.aICallLog.count({ where: { sessionId, status: 'BLOCKED' } }),
    ).toBe(1);
    expect(await prisma.aILearningTurn.count({ where: { sessionId } })).toBe(0);
  });

  it('材料域被拦截时 AICallLog.materialId 也非空（C-08）', async () => {
    const materialId = `cblockedmaterial${Date.now()}`;
    const outcome = await runAiCompletion({
      prisma,
      promptKind: 'material_extract',
      meta: { ...META, materialTitle: '被拦截的材料', materialChunksBlock: '<<<MATERIAL_DATA id="x">>' },
      attribution: { materialId, materialJobId: 'cblockedjob000000000000' },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('BUDGET_EXCEEDED');
    expect(outcome.logId).toBeTruthy();

    const log = await prisma.aICallLog.findUnique({ where: { id: outcome.logId } });
    expect(log?.status).toBe('BLOCKED');
    expect(log?.materialId).toBe(materialId);
    expect(log?.materialJobId).toBe('cblockedjob000000000000');
    // 教学回合的日志不该被材料归属污染
    expect(log?.sessionId).toBeNull();
  });

  it('幂等命中不重复调用：同 clientRequestId 第二次直接回放', async () => {
    await prisma.aIEngineSetting.updateMany({ data: { dailyBudgetUsd: 5 } });
    const sessionId = await createSession();
    const clientRequestId = `idem-${Date.now()}`;

    const first = await runAiTurn({
      prisma,
      sessionId,
      promptKind: 'hint',
      turnKind: 'HINT',
      meta: META,
      clientRequestId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.deduped).toBe(false);

    const logsAfterFirst = await prisma.aICallLog.count({ where: { sessionId } });

    const second = await runAiTurn({
      prisma,
      sessionId,
      promptKind: 'hint',
      turnKind: 'HINT',
      meta: META,
      clientRequestId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.deduped).toBe(true);
    expect(second.turnId).toBe(first.turnId);
    // 命中幂等 → 不再新增调用日志（预检查仍然在核心调用之前）
    expect(await prisma.aICallLog.count({ where: { sessionId } })).toBe(logsAfterFirst);
  });

  it('成功路径：会话 Token/成本累计与 turn 在同一事务里，日志带 sessionId', async () => {
    const sessionId = await createSession();
    const result = await runAiTurn({
      prisma,
      sessionId,
      promptKind: 'hint',
      turnKind: 'HINT',
      meta: META,
      clientRequestId: `ok-${Date.now()}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = await prisma.aILearningSession.findUnique({ where: { id: sessionId } });
    expect(session?.inputTokens ?? 0).toBeGreaterThan(0);
    expect(session?.totalLatencyMs ?? 0).toBeGreaterThanOrEqual(0);

    const turn = await prisma.aILearningTurn.findUnique({ where: { id: result.turnId } });
    expect(turn?.contentText.length ?? 0).toBeGreaterThan(0);
    // material 归属列对教学回合必须为 null
    const log = await prisma.aICallLog.findFirst({
      where: { sessionId, status: { in: ['OK', 'MOCK'] } },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).not.toBeNull();
    expect(log?.materialId).toBeNull();
    expect(log?.redactedMetadataJson ?? '').toContain('hint');
  });
});
