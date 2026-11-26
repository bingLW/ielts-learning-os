import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

export interface TestDb {
  prisma: PrismaClient;
  path: string;
  cleanup: () => void;
}

interface TestDbOptions {
  fixture?: 'empty' | 'seeded';
  temporaryRoot?: string;
}

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');
const schemaPath = resolve(process.cwd(), 'prisma', 'schema.prisma');

/** 从 Prisma schema 创建独立临时库；seeded 只添加定义型种子，不添加学习记录。 */
export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), 'ielts-test-'));
  const work = join(directory, 'test.db');
  const databaseUrl = `file:${work}`;

  try {
    execFileSync(
      process.execPath,
      [prismaCli, 'db', 'push', '--schema', schemaPath, '--skip-generate'],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    const detail = error instanceof Error
      ? `${error.message}\n${(error as Error & { stderr?: string }).stderr ?? ''}`
      : String(error);
    throw new Error(`createTestDb: 从 schema 建库失败：${detail}`);
  }

  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  if (globalForPrisma.prisma) await globalForPrisma.prisma.$disconnect();
  delete globalForPrisma.prisma;
  process.env.DATABASE_URL = `${databaseUrl}?connection_limit=1`;

  const { prisma } = await import('@/lib/prisma');
  globalForPrisma.prisma = prisma;
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');

  if (options.fixture === 'seeded') {
    const { seedDatabase } = await import('../../../../prisma/seed');
    await seedDatabase(prisma);
  }

  return {
    prisma,
    path: work,
    cleanup: () => {
      delete globalForPrisma.prisma;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
