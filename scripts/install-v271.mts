import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DB = resolve(ROOT, 'prisma', 'dev.db');
const MIGRATIONS = ['v2.2', 'v2.3', 'v2.4', 'v2.4.1', 'v2.4.2', 'v2.5', 'v2.6', 'v2.7', 'v2.7.1'];
const LEARNING_TABLES = [
  'planTask', 'planVersion', 'evidenceRecord', 'studySession', 'diagnosticAttempt',
  'placementReport', 'vocabWord', 'mistake', 'reviewTask', 'audioAsset',
] as const;

function usage(): never {
  throw new Error('用法：node scripts/install-v271.mts --db /absolute/path/new.db；只接受不存在或空的全新数据库');
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--db') usage();
const db = resolve(args[1]);
if (db === LIVE_DB) throw new Error('安全阻断：首次安装不得覆盖真实 prisma/dev.db');
if (!existsSync(dirname(db))) throw new Error('数据库父目录不存在');
if (existsSync(db) && statSync(db).size !== 0) {
  throw new Error('安全阻断：目标数据库非空；已有数据必须走版本化升级与备份，不得首次安装覆盖');
}

const databaseUrl = `file:${db}`;
execFileSync(process.execPath, [
  resolve(ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
  'db', 'push', '--schema', resolve(ROOT, 'prisma', 'schema.prisma'), '--skip-generate',
], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
try {
  const before = Object.fromEntries(await Promise.all(LEARNING_TABLES.map(async (table) => [
    table,
    await (prisma[table] as { count(): Promise<number> }).count(),
  ])));
  if (Object.values(before).some((count) => count !== 0)) {
    throw new Error('安全阻断：新库中检测到学习记录，拒绝 seed 与迁移登记');
  }

  const { seedDatabase } = await import('../prisma/seed.ts');
  await seedDatabase(prisma);
  const registered: Array<{ version: string; checksum: string }> = [];
  for (const version of MIGRATIONS) {
    const script = resolve(ROOT, 'scripts', 'migrations', `${version}.mjs`);
    const checksum = execFileSync(process.execPath, [script, '--checksum-only'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[a-f0-9]{16,64}$/.test(checksum)) throw new Error(`${version} 返回无效 checksum`);
    const existing = await prisma.appMigration.findUnique({ where: { version } });
    if (existing && existing.checksum !== checksum) {
      throw new Error(`${version} 已有不同 checksum，拒绝覆盖迁移账本`);
    }
    await prisma.appMigration.upsert({
      where: { version },
      create: { id: `appmig-${version}`, version, checksum, note: '全新安装：schema 已建，登记权威迁移 checksum' },
      update: {},
    });
    registered.push({ version, checksum });
  }

  const after = Object.fromEntries(await Promise.all(LEARNING_TABLES.map(async (table) => [
    table,
    await (prisma[table] as { count(): Promise<number> }).count(),
  ])));
  if (Object.values(after).some((count) => count !== 0)) {
    throw new Error('seed 写入了禁止的学习记录，首次安装校验失败');
  }
  const integrity = await prisma.$queryRawUnsafe('PRAGMA integrity_check;') as Array<{ integrity_check: string }>;
  const foreignKeys = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check;') as unknown[];
  if (integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) {
    throw new Error('首次安装后完整性或外键校验失败');
  }

  console.log(JSON.stringify({
    ok: true,
    database: db,
    migrations: registered.map((row) => row.version),
    learningRows: after,
    integrity: 'ok',
    foreignKeyViolations: 0,
  }));
} finally {
  await prisma.$disconnect();
}
