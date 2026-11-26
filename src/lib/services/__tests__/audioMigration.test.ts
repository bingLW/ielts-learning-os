/** v2.7.1 迁移只在 /tmp createTestDb 库上验证：加列、行数保持、备份、幂等和 checksum。 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/lib/__tests__/helpers/testDb';

const script = path.resolve('scripts/migrations/v2.7.1.mjs');
let db: TestDb | null = null;

afterEach(async () => {
  if (db) {
    await db.prisma.$disconnect();
    db.cleanup();
    db = null;
  }
});

async function baseline() {
  db = await createTestDb({ temporaryRoot: '/tmp' });
  await db.prisma.appMigration.create({ data: { id: 'appmig-v2.7', version: 'v2.7', checksum: 'baseline', note: 'test' } });
  const asset = await db.prisma.audioAsset.create({ data: { title: 'keep me', filePath: 'keep.wav' } });
  await db.prisma.recordingAsset.create({ data: { filePath: 'keep.webm' } });
  // 从当前 schema 临时库去掉本次新列/索引，构造待升级的 v2.7 基线形状。
  await db.prisma.$executeRawUnsafe('DROP INDEX "AudioAsset_deletedAt_idx";');
  await db.prisma.$executeRawUnsafe('DROP INDEX "RecordingAsset_deletedAt_idx";');
  await db.prisma.$executeRawUnsafe('ALTER TABLE "AudioAsset" DROP COLUMN "deletedAt";');
  await db.prisma.$executeRawUnsafe('ALTER TABLE "AudioAsset" DROP COLUMN "deletionReason";');
  await db.prisma.$executeRawUnsafe('ALTER TABLE "RecordingAsset" DROP COLUMN "deletedAt";');
  await db.prisma.$executeRawUnsafe('ALTER TABLE "RecordingAsset" DROP COLUMN "deletionReason";');
  return asset;
}

function run(target: TestDb, args: string[] = []) {
  return execFileSync(process.execPath, [script, '--db', target.path, ...args], {
    env: { ...process.env, DATABASE_URL: `file:${target.path}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('v2.7.1 隔离迁移', () => {
  it('dry-run 零写入；正式执行自动备份、保留行/旧列，二次执行幂等', async () => {
    const asset = await baseline();
    const target = db;
    if (!target) throw new Error('missing test db');
    expect(target.path).toMatch(/^\/(?:private\/)?tmp\//);
    const beforeDryRun = createHash('sha256').update(readFileSync(target.path)).digest('hex');
    const dry = JSON.parse(run(target, ['--dry-run']));
    expect(dry.pendingStatements).toHaveLength(6);
    expect(createHash('sha256').update(readFileSync(target.path)).digest('hex')).toBe(beforeDryRun);
    const columns = await target.prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("AudioAsset");');
    expect(columns.map((row) => row.name)).not.toContain('deletedAt');

    const output = run(target);
    const report = JSON.parse(output);
    expect(report.ok).toBe(true);
    expect(report.integrity).toBe('ok');
    expect(report.backupIntegrity).toBe('ok');
    expect(report.backupForeignKeyViolations).toBe(0);
    expect(report.backupRowDrift).toEqual([]);
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.rowDrift).toEqual([]);
    expect(report.columnProblems).toEqual([]);
    expect(existsSync(report.backup)).toBe(true);
    expect(readdirSync(path.dirname(target.path)).some((name) => name.includes('.pre-v2.7.1-'))).toBe(true);
    expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).ok).toBe(true);
    expect((await target.prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } })).title).toBe('keep me');
    expect(await target.prisma.audioAsset.count()).toBe(1);
    expect(await target.prisma.recordingAsset.count()).toBe(1);

    const second = JSON.parse(run(target));
    expect(second.ok).toBe(true);
    expect(second.appliedStatements.filter((statement: string) => statement.startsWith('ALTER'))).toEqual([]);
    expect(await target.prisma.audioAsset.count()).toBe(1);
    expect(await target.prisma.recordingAsset.count()).toBe(1);
  }, 30000);

  it('已有新列但定义不正确时在备份/写库前拒绝', async () => {
    await baseline();
    const target = db;
    if (!target) throw new Error('missing test db');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AudioAsset" ADD COLUMN "deletedAt" TEXT;');
    const before = createHash('sha256').update(readFileSync(target.path)).digest('hex');
    expect(() => run(target)).toThrow(/定义不正确/);
    expect(createHash('sha256').update(readFileSync(target.path)).digest('hex')).toBe(before);
    expect(await target.prisma.appMigration.count({ where: { version: 'v2.7.1' } })).toBe(0);
  }, 30000);

  it('已登记版本 checksum 被改动时拒绝执行且不修改库', async () => {
    await baseline();
    const target = db;
    if (!target) throw new Error('missing test db');
    await target.prisma.appMigration.create({ data: { id: 'appmig-v2.7.1', version: 'v2.7.1', checksum: 'tampered', note: 'test' } });
    expect(() => run(target)).toThrow(/checksum 不一致/);
    expect((await target.prisma.appMigration.findUniqueOrThrow({ where: { version: 'v2.7.1' } })).checksum).toBe('tampered');
    expect(await target.prisma.audioAsset.count()).toBe(1);
  }, 30000);
});
