import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';

const { prisma, cleanup } = await createTestDb({ temporaryRoot: '/tmp' });
const { buildDomainExport } = await import('@/lib/export/domain');

beforeAll(async () => {
  await prisma.stage.create({
    data: { id: 'export-stage', code: 'S1_A0_A2', nameZh: '导出测试阶段', estDaysMin: 30, status: 'ACTIVE' },
  });
  await prisma.egiuLesson.createMany({ data: [
    {
      stageId: 'export-stage', unitNo: 'spring', knowledgePoint: '春季 DST', learnedDate: '2026-03-08',
      masteredAt: new Date('2026-03-09T02:30:00.000Z'),
    },
    {
      stageId: 'export-stage', unitNo: 'fall', knowledgePoint: '秋季 DST', learnedDate: '2026-11-01',
      masteredAt: new Date('2026-11-02T03:30:00.000Z'),
    },
    {
      stageId: 'export-stage', unitNo: 'shanghai', knowledgePoint: '东八区日界', learnedDate: '2026-11-25',
      masteredAt: new Date('2026-11-25T16:30:00.000Z'),
    },
  ] });
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('IANA 业务日：语法报表掌握日期', () => {
  it.each([
    { unitNo: 'spring', timeZone: 'America/New_York', expected: '2026-03-08' },
    { unitNo: 'fall', timeZone: 'America/New_York', expected: '2026-11-01' },
    { unitNo: 'shanghai', timeZone: 'Asia/Shanghai', expected: '2026-11-26' },
  ])('$unitNo 按 $timeZone 输出 $expected，而不是 UTC 日期', async ({ unitNo, timeZone, expected }) => {
    const report = await buildDomainExport('grammar', timeZone);
    const row = report.rows.find((cells) => cells[1] === unitNo);
    expect(row?.[9]).toBe(expected);
  });
});
