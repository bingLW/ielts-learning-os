import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const helper = join(project, 'scripts/backup-bundle.mjs');
const restoreScript = join(project, 'scripts/restore.sh');
const sqlite = '/usr/bin/sqlite3';
const migrationScripts = readdirSync(join(project, 'scripts/migrations'))
  .filter((name) => /^v\d+(?:\.\d+)*\.mjs$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ielts-backup-script-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(args, { env = {}, input } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: project, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function checksumOnly(script, databasePath) {
  const result = run([script, '--checksum-only'], { env: { DATABASE_URL: `file:${databasePath}` } });
  assert.equal(result.status, 0, `${script} checksum-only 失败：${result.stderr}`);
  assert.match(result.stdout, /^[a-f0-9]{16,128}\n$/, `${script} 必须只输出一行权威 checksum`);
  return result.stdout.trim();
}

function sq(db, sqlText) {
  return execFileSync(sqlite, ['-batch', '-bail', '-noheader', '-list', db], {
    input: sqlText, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function isolatedDatabase(root, checksumOverrides = {}) {
  const prisma = join(root, 'prisma');
  mkdirSync(prisma, { recursive: true });
  const db = join(prisma, 'dev.db');
  const missingDb = join(root, 'no-db.db');
  const rows = migrationScripts.map((name, index) => {
    const version = name.slice(0, -'.mjs'.length);
    const checksum = checksumOverrides[version] ?? checksumOnly(join(project, 'scripts/migrations', name), missingDb);
    return `('test-${index}','${version}','${checksum}','2026-11-27T00:00:00.000Z','isolated test')`;
  }).join(',\n');
  sq(db, `
    CREATE TABLE "AppMigration"("id" TEXT PRIMARY KEY, "version" TEXT UNIQUE, "checksum" TEXT, "appliedAt" TEXT, "note" TEXT);
    INSERT INTO "AppMigration" VALUES ${rows};
  `);
  assert.equal(existsSync(missingDb), false, '测试账本构造不得创建 checksum-only 数据库');
  return db;
}

function createBundle(db, uploads, output) {
  return run([helper, 'create', '--db', db, '--uploads', uploads, '--output', output]);
}

test('所有迁移脚本的 checksum-only 模式不读/写数据库', (t) => {
  const root = temporaryRoot(t);
  const missingDb = join(root, 'must-not-be-created.db');
  assert.ok(migrationScripts.length > 0, '仓库必须存在迁移脚本');
  for (const name of migrationScripts) {
    const checksum = checksumOnly(join(project, 'scripts/migrations', name), missingDb);
    assert.ok(checksum.length >= 16, `${name} checksum 长度无效`);
  }
  assert.equal(existsSync(missingDb), false, 'checksum-only 不得创建数据库');
});

test('createBundle 在 uploads 缺失时失败且不发布产物', (t) => {
  const root = temporaryRoot(t);
  const db = isolatedDatabase(root);
  const uploads = join(root, 'storage/uploads');
  mkdirSync(join(root, 'storage'), { recursive: true });
  const output = join(root, 'missing-uploads.tar');

  const result = createBundle(db, uploads, output);
  assert.notEqual(result.status, 0, 'uploads 缺失时备份必须失败');
  assert.match(result.stderr, /目录不存在：.*storage\/uploads/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.sha256`), false);
});

test('合法空 uploads 被明确记录并能恢复到空目录', (t) => {
  const root = temporaryRoot(t);
  const db = isolatedDatabase(root);
  const sourceHash = readFileSync(db);
  const uploads = join(root, 'storage/uploads');
  mkdirSync(uploads, { recursive: true });
  const bundle = join(root, 'empty-uploads.tar');

  const created = createBundle(db, uploads, bundle);
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOf', bundle, 'manifest.json'], { encoding: 'utf8' }));
  assert.deepEqual(manifest.uploads, { path: 'storage/uploads', empty: true, fileCount: 0 });
  assert.deepEqual(Object.keys(manifest.files), ['prisma/dev.db']);
  assert.deepEqual(readFileSync(db), sourceHash, '备份不得修改隔离源库');

  const restored = spawnSync('/bin/bash', [restoreScript, bundle], {
    cwd: project, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_BIN: process.execPath, IELTS_DB_PATH: '' },
  });
  assert.equal(restored.status, 0, restored.stderr);
  const target = restored.stdout.match(/^RESTORED target=(.+)$/m)?.[1];
  assert.ok(target?.startsWith('/tmp/ielts-restore-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const restoredUploads = join(target, 'storage/uploads');
  assert.equal(existsSync(restoredUploads), true, '空 uploads 目录必须存在');
  assert.deepEqual(readdirSync(restoredUploads), []);
  assert.equal(sq(join(target, 'prisma/dev.db'), 'PRAGMA integrity_check;'), 'ok');
});

test('createBundle 拒绝格式合法但非权威的 AppMigration checksum', (t) => {
  const root = temporaryRoot(t);
  const authoritative = checksumOnly(join(project, 'scripts/migrations/v2.2.mjs'), join(root, 'no-db.db'));
  const altered = authoritative === 'deadbeefdeadbeef' ? 'cafebabecafebabe' : 'deadbeefdeadbeef';
  const db = isolatedDatabase(root, { 'v2.2': altered });
  const uploads = join(root, 'storage/uploads');
  mkdirSync(uploads, { recursive: true });
  const output = join(root, 'bad-checksum.tar');

  const result = createBundle(db, uploads, output);
  assert.notEqual(result.status, 0, '非权威 checksum 必须拒绝备份');
  assert.match(result.stderr, /AppMigration checksum 与迁移脚本权威值不一致：v2\.2/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.sha256`), false);
});
