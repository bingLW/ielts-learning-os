import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { prisma, cleanup } = await createTestDb({ temporaryRoot: '/tmp' });
const { updateProfileAction } = await import('@/lib/actions/settings');
const { getProfile } = await import('@/lib/queries/profile');

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('时区设置与历史时间戳', () => {
  it('修改时区只更新画像，不重写历史 UTC 时间戳和业务日快照', async () => {
    const profile = await prisma.userProfile.create({ data: { timezone: 'Asia/Singapore' } });
    const startedAt = new Date('2026-11-26T23:30:00.000Z');
    const endedAt = new Date('2026-11-27T00:30:00.000Z');
    const session = await prisma.studySession.create({ data: {
      startedAt, endedAt, activeMinutes: 60, terminatedReason: 'COMPLETED', sessionDate: '2026-11-27',
    } });

    const invalid = await updateProfileAction({
      targetBandOverall: 6.5, dailyMinutes: 240, weeklyReviewDow: 0, timezone: 'UTC+08:00',
    });
    expect(invalid).toMatchObject({ ok: false, code: 'VALIDATION' });

    const updated = await updateProfileAction({
      targetBandOverall: 6.5, dailyMinutes: 240, weeklyReviewDow: 0, timezone: 'America/New_York',
    });
    expect(updated).toMatchObject({ ok: true, data: { timezone: 'America/New_York' } });
    expect((await prisma.userProfile.findUniqueOrThrow({ where: { id: profile.id } })).createdAt).toEqual(profile.createdAt);
    const retained = await prisma.studySession.findUniqueOrThrow({ where: { id: session.id } });
    expect(retained.startedAt).toEqual(startedAt);
    expect(retained.endedAt).toEqual(endedAt);
    expect(retained.sessionDate).toBe('2026-11-27');
  });

  it('首次并发读取配置只创建一行默认画像', async () => {
    await prisma.userProfile.deleteMany();
    const [first, second] = await Promise.all([getProfile(), getProfile()]);
    expect(first.id).toBe(1);
    expect(second.id).toBe(1);
    expect(first.timezone).toBe('Asia/Singapore');
    expect(await prisma.userProfile.count()).toBe(1);
  });
});
