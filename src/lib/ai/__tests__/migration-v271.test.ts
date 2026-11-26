import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/lib/__tests__/helpers/testDb';

const script = resolve(process.cwd(), 'scripts/migrations/v2.7.1.mjs');
let db: TestDb | null = null;

afterEach(async () => {
  if (db) {
    await db.prisma.$disconnect();
    db.cleanup();
    db = null;
  }
});

function run(target: TestDb) {
  return execFileSync(process.execPath, [script, '--db', target.path], {
    env: { ...process.env, DATABASE_URL: `file:${target.path}` },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('v2.7.1 AI 预算预占纯加法迁移', () => {
  it('保留其他 agent 的 tombstone 内容并幂等追加预算预占列', async () => {
    db = await createTestDb({ temporaryRoot: '/tmp' });
    const target = db;
    await target.prisma.appMigration.create({
      data: { id: 'appmig-v2.7', version: 'v2.7', checksum: 'baseline', note: 'test' },
    });
    const asset = await target.prisma.audioAsset.create({
      data: { title: 'keep me', filePath: 'keep.wav' },
    });
    const recording = await target.prisma.recordingAsset.create({
      data: { filePath: 'keep.webm' },
    });
    await target.prisma.aIEngineSetting.create({ data: { id: 'default' } });

    // 构造待升级形状：保留音频 tombstone 升级能力，同时去掉预算预占列。
    await target.prisma.$executeRawUnsafe('DROP INDEX "AudioAsset_deletedAt_idx";');
    await target.prisma.$executeRawUnsafe('DROP INDEX "RecordingAsset_deletedAt_idx";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AudioAsset" DROP COLUMN "deletedAt";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AudioAsset" DROP COLUMN "deletionReason";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "RecordingAsset" DROP COLUMN "deletedAt";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "RecordingAsset" DROP COLUMN "deletionReason";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AIEngineSetting" DROP COLUMN "budgetReservedUsd";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AssessmentResult" DROP COLUMN "aiCallLogId";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AssessmentResult" DROP COLUMN "aiModelId";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "AssessmentResult" DROP COLUMN "aiPromptVersionId";');
    await target.prisma.$executeRawUnsafe('ALTER TABLE "SpeakingPrompt" DROP COLUMN "active";');

    const first = JSON.parse(run(target)) as { ok: boolean; appliedStatements: string[] };
    expect(first.ok).toBe(true);
    expect(first.appliedStatements.filter((statement) => statement.startsWith('ALTER'))).toHaveLength(9);
    const second = JSON.parse(run(target)) as { ok: boolean; appliedStatements: string[] };
    expect(second.ok).toBe(true);
    expect(second.appliedStatements.filter((statement) => statement.startsWith('ALTER'))).toEqual([]);

    const setting = await target.prisma.aIEngineSetting.findUniqueOrThrow({ where: { id: 'default' } });
    expect(setting.budgetReservedUsd).toBe(0);
    expect((await target.prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } })).title).toBe('keep me');
    expect((await target.prisma.recordingAsset.findUniqueOrThrow({ where: { id: recording.id } })).filePath).toBe('keep.webm');
    expect(await target.prisma.appMigration.count({ where: { version: 'v2.7.1' } })).toBe(1);
    expect(await target.prisma.$queryRawUnsafe('PRAGMA integrity_check;')).toEqual([{ integrity_check: 'ok' }]);
  }, 30_000);

  it('拒绝真实 prisma/dev.db，即使显式传入', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [script, '--db', resolve(process.cwd(), 'prisma/dev.db')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toThrow();
  });
});
