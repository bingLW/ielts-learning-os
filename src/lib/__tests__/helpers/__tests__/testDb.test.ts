import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../testDb';

const developmentDb = join(process.cwd(), 'prisma', 'dev.db');
const developmentChecksum = createHash('sha256')
  .update(readFileSync(developmentDb))
  .digest('hex');

afterAll(() => {
  const current = createHash('sha256').update(readFileSync(developmentDb)).digest('hex');
  expect(current).toBe(developmentChecksum);
});

describe('createTestDb 夹具', () => {
  it('默认从 schema 创建空库，不继承真实学习数据', async () => {
    const db = await createTestDb();
    try {
      expect(await db.prisma.learningGoal.count()).toBe(0);
      expect(await db.prisma.planTask.count()).toBe(0);
      expect(await db.prisma.evidenceRecord.count()).toBe(0);
      expect(await db.prisma.planningSnapshot.count()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('seeded 只写定义型数据，不写计划或证据', async () => {
    const db = await createTestDb({ fixture: 'seeded' });
    try {
      expect(await db.prisma.userProfile.count()).toBe(1);
      expect(await db.prisma.stage.count()).toBeGreaterThan(0);
      expect(await db.prisma.learningGoal.count()).toBeGreaterThan(0);
      expect(await db.prisma.planTask.count()).toBe(0);
      expect(await db.prisma.evidenceRecord.count()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('连续两次建库使用不同路径', async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    try {
      expect(first.path).not.toBe(second.path);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  }, 15000);

  it('cleanup 删除临时库文件', async () => {
    const db = await createTestDb();
    expect(existsSync(db.path)).toBe(true);
    db.cleanup();
    expect(existsSync(db.path)).toBe(false);
  });
});
