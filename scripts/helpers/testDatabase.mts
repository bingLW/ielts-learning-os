import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

export async function createScriptTestDatabase(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const path = join(directory, 'test.db');
  const databaseUrl = `file:${path}?connection_limit=1`;

  try {
    execFileSync(
      process.execPath,
      [prismaCli, 'db', 'push', '--schema', resolve(process.cwd(), 'prisma/schema.prisma'), '--skip-generate'],
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
    throw new Error(`createScriptTestDatabase: 从 schema 建库失败：${detail}`);
  }

  process.env.DATABASE_URL = databaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  const { seedDatabase } = await import('../../prisma/seed.ts');
  const prisma = new PrismaClient();
  try {
    await seedDatabase(prisma);
  } catch (error) {
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    prisma,
    path,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
