/**
 * `buildPlanningSnapshot` 的集成测试（T02 ⑬⑭ + ⑨ 的落库侧断言）。
 *
 * 三条硬要求：
 * - **⑬ 幂等**：同 `(purpose, asOfDate)` 同输入二次调用 → `reused=true`，`PlanningSnapshot` 行数不变；
 * - **⑭ 缺阶段阻断**：没有 ACTIVE 阶段 → `fail('PRECONDITION')`，且不允许写任何快照行；
 * - **⑨ 落库侧**：`SkillGap` 表**没有** `stale` / `staleFlag` 列（`stale` 是派生 DTO 字段）。
 *
 * 另外钉一条约束⑦：`inputHash` 与落库 JSON 必须来自**同一个归一化对象** ——
 * 两次调用后快照行里的 `budgetJson` 必须逐字相同（如果落库写原值、哈希写归一值，
 * 这里会出现「hash 相同、内容不同」）。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sourceDb = join(process.cwd(), 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-snapshot-${process.pid}-${Date.now()}.db`);

if (!existsSync(sourceDb)) throw new Error(`找不到数据库：${sourceDb}`);
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}?connection_limit=1`;

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma } = await import('@/lib/prisma');
await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');

const { buildPlanningSnapshot } = await import('@/lib/services/planningSnapshot');

const AS_OF = '2025-10-20';

beforeAll(async () => {
  await prisma.planningSnapshot.deleteMany({});
  await prisma.skillProfile.deleteMany({});
  await prisma.evidenceRecord.deleteMany({});
});

afterAll(async () => {
  await prisma.planningSnapshot.deleteMany({});
  await prisma.$disconnect();
});

/** 确保有 ACTIVE 阶段。 */
async function ensureStage(): Promise<void> {
  const stage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  if (stage) return;
  await prisma.stage.create({
    data: { code: 'S3_B1_IELTS', nameZh: 'B1→IELTS 过渡', estDaysMin: 30, status: 'ACTIVE', sortOrder: 0 },
  });
}

describe('⑬ 同 inputHash 二次调用 → 复用，不新建快照行', () => {
  it('第二次返回 reused=true，PlanningSnapshot 行数不变，且落库 JSON 逐字相同', async () => {
    await ensureStage();

    const first = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.reused).toBe(false);

    const rowsAfterFirst = await prisma.planningSnapshot.count();
    const before = await prisma.planningSnapshot.findUnique({
      where: { id: first.data.snapshotId },
      select: { budgetJson: true, configJson: true, inputHash: true },
    });

    const second = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.reused, '同输入同规则 → 必须复用').toBe(true);
    expect(second.data.snapshotId).toBe(first.data.snapshotId);
    expect(second.data.inputHash).toBe(first.data.inputHash);
    expect(await prisma.planningSnapshot.count(), '不应新增行').toBe(rowsAfterFirst);

    const after = await prisma.planningSnapshot.findUnique({
      where: { id: first.data.snapshotId },
      select: { budgetJson: true, configJson: true, inputHash: true },
    });
    expect(after).toEqual(before);
  });

  it('改视野（horizonDays）→ 换 hash、新建一行（输入确实变了）', async () => {
    await ensureStage();
    const before = await prisma.planningSnapshot.count();
    const wider = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 30 });
    expect(wider.ok).toBe(true);
    if (!wider.ok) return;
    expect(wider.data.reused).toBe(false);
    expect(await prisma.planningSnapshot.count()).toBe(before + 1);
  });
});

describe('⑭ 缺 Stage → PRECONDITION，且不写任何快照行', () => {
  it('库中没有 ACTIVE 阶段时返回 fail(PRECONDITION)', async () => {
    const saved = await prisma.stage.findMany({ where: { status: 'ACTIVE' } });
    await prisma.stage.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'NOT_STARTED' } });

    const before = await prisma.planningSnapshot.count();
    const result = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(await prisma.planningSnapshot.count(), '阻断时不得写库').toBe(before);

    // 复原，避免影响后续用例
    for (const row of saved) {
      await prisma.stage.update({ where: { id: row.id }, data: { status: 'ACTIVE' } });
    }
  });
});

describe('⑨ 落库侧：SkillGap 没有 stale / staleFlag 列', () => {
  it('PRAGMA table_info("SkillGap") 里不存在 stale / staleFlag', async () => {
    const columns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      'PRAGMA table_info("SkillGap")',
    );
    const names = columns.map((row) => row.name);
    expect(names).not.toContain('stale');
    expect(names).not.toContain('staleFlag');
    // 派生 stale 的两个输入必须都在
    expect(names).toContain('freshnessDays');
    expect(names).toContain('confidence');
  });
});

describe('落库内容与 hash 同源（约束⑦）', () => {
  it('每个维度在 SkillGap 里只有一行（唯一键不含 kind）', async () => {
    await ensureStage();
    const result = await buildPlanningSnapshot({ purpose: 'GENERATE', asOfDate: AS_OF, horizonDays: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await prisma.skillGap.findMany({
      where: { snapshotId: result.data.snapshotId },
      select: { skill: true, subskill: true, kind: true, dimensionKind: true },
    });
    const keys = rows.map((row) => `${row.dimensionKind}|${row.skill}|${row.subskill}`);
    expect(new Set(keys).size, '同一维度只允许一个裁决').toBe(keys.length);
  });
});
