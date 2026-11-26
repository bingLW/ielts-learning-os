#!/usr/bin/env node
/** Repeatable P0-6 drill: builds its own full SQLite schema under /tmp; never uses prisma/dev.db. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sqlite = '/usr/bin/sqlite3';
const keep = process.argv.includes('--keep');
const root = mkdtempSync('/tmp/ielts-backup-drill-');
const source = join(root, 'source');
const sourceDb = join(source, 'prisma/dev.db');
const uploads = join(source, 'storage/uploads');
const backupDir = join(root, 'backups');
const helper = join(project, 'scripts/backup-bundle.mjs');
const backupScript = join(project, 'scripts/backup.sh');
const restoreScript = join(project, 'scripts/restore.sh');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BLOCK = 512;
let negativeCount = 0;

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sq(db, sql, json = false) {
  const args = ['-batch', '-noheader', ...(json ? ['-json'] : ['-list']), db, sql];
  const output = execFileSync(sqlite, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  return json && output ? JSON.parse(output) : output;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: project, encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, ...options.env },
    input: options.input, maxBuffer: 32 * 1024 * 1024,
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${options.label || command} 应失败，但成功了：\n${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    if (options.pattern) assert.match(output, options.pattern, `${options.label || command} 错误信息不匹配：\n${output}`);
    return result;
  }
  assert.equal(result.status, 0, `${command} ${args.join(' ')} 失败：\n${result.stdout}\n${result.stderr}`);
  return result;
}
function expectReject(label, bundle, pattern, env = {}) {
  run('/bin/bash', [restoreScript, bundle], { expectFailure: true, label, pattern, env });
  negativeCount += 1;
  console.log(`NEGATIVE ${label}: rejected`);
}
function sourceFingerprint() {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push([path, sha(readFileSync(path))]);
    }
  }
  walk(source);
  return files;
}
function tarString(header, start, length) { return decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/, ''); }
function tarNumber(header, start, length) {
  const text = tarString(header, start, length).trim();
  assert.match(text, /^[0-7]+$/, 'fixture tar 数字字段非法');
  return Number.parseInt(text, 8);
}
function readTar(path) {
  const bytes = readFileSync(path);
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    let name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const linkname = tarString(header, 157, 100);
    entries.push({ name, type, linkname, data: bytes.subarray(offset + BLOCK, offset + BLOCK + size) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
function header(name, size, type = '0', linkname = '') {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000600\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}
function writeTar(path, entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    parts.push(header(entry.name, data.length, entry.type ?? '0', entry.linkname ?? ''), data);
    const padding = (BLOCK - data.length % BLOCK) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  writeFileSync(path, Buffer.concat(parts), { mode: 0o600 });
}
function writeSidecar(bundle) {
  writeFileSync(`${bundle}.sha256`, `${sha(readFileSync(bundle))}  ${basename(bundle)}\n`, { mode: 0o600 });
}
function checksumsFor(entries) {
  const manifestBytes = entries.find((entry) => entry.name === 'manifest.json').data;
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  const lines = Object.entries(manifest.files).map(([name, info]) => [name, info.sha256]);
  lines.push(['manifest.json', sha(manifestBytes)]);
  lines.sort(([a], [b]) => a.localeCompare(b));
  return Buffer.from(`${lines.map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`);
}
function writeBundle(path, entries) {
  writeTar(path, entries);
  writeSidecar(path);
}
function rewrite(bundle, destination, mutate) {
  const entries = mutate(readTar(bundle));
  const index = entries.findIndex((entry) => entry.name === 'checksums.sha256');
  if (index >= 0 && entries.some((entry) => entry.name === 'manifest.json')) entries[index].data = checksumsFor(entries);
  writeBundle(destination, entries);
  return destination;
}
function replaceDatabase(bundle, destination, mutateDb) {
  return rewrite(bundle, destination, (entries) => {
    const dbEntry = entries.find((entry) => entry.name === 'prisma/dev.db');
    const changed = join(root, `changed-${basename(destination)}.db`);
    writeFileSync(changed, dbEntry.data, { mode: 0o600 });
    mutateDb(changed);
    dbEntry.data = readFileSync(changed);
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
    const manifest = JSON.parse(decoder.decode(manifestEntry.data));
    manifest.files['prisma/dev.db'] = { size: dbEntry.data.length, sha256: sha(dbEntry.data) };
    manifest.totalBytes = Object.values(manifest.files).reduce((sum, info) => sum + info.size, 0);
    manifestEntry.data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    return entries;
  });
}

try {
  mkdirSync(join(source, 'prisma'), { recursive: true });
  mkdirSync(join(uploads, 'audio'), { recursive: true });
  mkdirSync(join(uploads, 'notes/nested'), { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  console.log(`DRILL_ROOT=${root}`);
  console.log(`COMMAND node scripts/backup-restore-drill.mjs${keep ? ' --keep' : ''}`);
  console.log('ISOLATION source schema is created with prisma db push into /tmp; real prisma/dev.db is never a backup source or restore target.');

  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--schema', join(project, 'prisma/schema.prisma'), '--skip-generate'], {
    cwd: project, env: { ...process.env, DATABASE_URL: `file:${sourceDb}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const migrationVersions = readdirSync(join(project, 'scripts/migrations'))
    .map((name) => name.match(/^v(\d+(?:\.\d+)*)\.mjs$/)?.[1]).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const migrationChecksums = new Map(migrationVersions.map((version) => {
    const script = join(project, 'scripts/migrations', `v${version}.mjs`);
    const checksum = execFileSync(process.execPath, [script, '--checksum-only'], {
      cwd: project, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: `file:${join(root, 'checksum-only-no-db.db')}` },
    }).trim();
    assert.match(checksum, /^[a-f0-9]{16,128}$/, `${script} 必须只输出权威 checksum`);
    return [`v${version}`, checksum];
  }));
  assert.equal(existsSync(join(root, 'checksum-only-no-db.db')), false, 'checksum-only 不得创建数据库');
  const migrations = migrationVersions.map((version, index) =>
    `INSERT INTO "AppMigration"("id","version","checksum","appliedAt","note") VALUES('drill-${index}','v${version}','${migrationChecksums.get(`v${version}`)}','2026-11-26T00:00:00.000Z','isolated drill');`).join('\n');
  sq(sourceDb, `
    PRAGMA foreign_keys=ON;
    BEGIN IMMEDIATE;
    INSERT INTO "Stage"("id","code","nameZh","estDaysMin","updatedAt") VALUES('stage-1','S1_A0_A2','Drill',7,'2026-11-26T00:00:00.000Z');
    INSERT INTO "StageAcceptanceItem"("id","stageId","dimension","criterionText","updatedAt") VALUES('accept-1','stage-1','LISTENING','Drill criterion','2026-11-26T00:00:00.000Z');
    INSERT INTO "Resource"("id","name","subject","type","updatedAt") VALUES('resource-1','Drill resource','LISTENING','AUDIO_SERIES','2026-11-26T00:00:00.000Z');
    INSERT INTO "StudySession"("id","startedAt","endedAt","activeMinutes","terminatedReason","sessionDate") VALUES('session-1','2026-11-26T00:00:00.000Z','2026-11-26T00:30:00.000Z',30,'COMPLETED','2026-11-26');
    INSERT INTO "StudySession"("id","startedAt","endedAt","activeMinutes","terminatedReason","sessionDate") VALUES('session-2','2026-11-26T01:00:00.000Z','2026-11-26T01:15:00.000Z',15,'COMPLETED','2026-11-26');
    ${migrations}
    COMMIT;
    PRAGMA user_version=1;
    PRAGMA journal_mode=DELETE;
  `);
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2, 3, 4]);
  writeFileSync(join(uploads, 'audio/sample.wav'), audio, { mode: 0o600 });
  writeFileSync(join(uploads, 'notes/nested/note.txt'), 'isolated upload\n', { mode: 0o600 });
  writeFileSync(join(uploads, 'empty.bin'), Buffer.alloc(0), { mode: 0o600 });
  sq(sourceDb, `INSERT INTO "EvidenceAttachment"("id","fileUri","evidenceType","linkedEntity","linkedId","sizeBytes","checksum") VALUES('evidence-1','storage/uploads/audio/sample.wav','RECORDING','STUDY_RECORD','record-1',${audio.length},'${sha(audio)}');`);
  sq(sourceDb, `INSERT INTO "AudioAsset"("id","title","source","filePath","fileName","mimeType","sizeBytes","sha256") VALUES('audio-1','Drill audio','UPLOAD','audio/sample.wav','sample.wav','audio/wav',${audio.length},'${sha(audio)}');`);
  assert.equal(sq(sourceDb, 'PRAGMA integrity_check;'), 'ok');
  assert.equal(sq(sourceDb, 'PRAGMA foreign_key_check;'), '');

  const before = JSON.stringify(sourceFingerprint());
  const backup = run('/bin/bash', [backupScript], {
    env: { IELTS_DB_PATH: sourceDb, IELTS_UPLOADS_DIR: uploads, IELTS_BACKUP_DIR: backupDir },
  });
  process.stdout.write(backup.stdout);
  const bundle = join(backupDir, readdirSync(backupDir).find((name) => name.endsWith('.tar')));
  assert.ok(existsSync(`${bundle}.sha256`), '整体 checksum 必须与 bundle 同时生成');
  assert.equal(JSON.stringify(sourceFingerprint()), before, '备份不得修改源 DB/uploads');

  const entries = readTar(bundle);
  const manifestBytes = entries.find((entry) => entry.name === 'manifest.json').data;
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  const archiveHash = sha(readFileSync(bundle));
  assert.equal(archiveHash, readFileSync(`${bundle}.sha256`, 'utf8').slice(0, 64));
  assert.ok(entries.some((entry) => entry.name === 'checksums.sha256'));
  assert.equal(manifest.database.path, 'prisma/dev.db');
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.appMigrations.map((row) => row.version), migrationVersions.map((version) => `v${version}`));
  for (const row of manifest.appMigrations) assert.equal(row.checksum, migrationChecksums.get(row.version), `${row.version} 必须使用迁移脚本真实 checksum`);
  assert.deepEqual(manifest.uploads, { path: 'storage/uploads', empty: false, fileCount: 3 });
  assert.equal(manifest.files['storage/uploads/audio/sample.wav'].sha256, sha(audio));
  console.log(`CHECKSUM bundle=${archiveHash}`);
  console.log(`CHECKSUM migrations=${migrationChecksums.size} source=scripts`);
  console.log(`CHECKSUM db=${manifest.files['prisma/dev.db'].sha256}`);
  console.log(`CHECKSUM upload=${manifest.files['storage/uploads/audio/sample.wav'].sha256}`);

  const restored = run('/bin/bash', [restoreScript, bundle]);
  process.stdout.write(restored.stdout);
  const target = restored.stdout.match(/^RESTORED target=(.+)$/m)?.[1];
  assert.ok(target?.startsWith('/tmp/ielts-restore-'), '默认恢复必须使用 /tmp 新目录');
  const restoredDb = join(target, 'prisma/dev.db');
  assert.equal(sq(restoredDb, 'PRAGMA integrity_check;'), 'ok');
  assert.equal(sq(restoredDb, 'PRAGMA foreign_key_check;'), '');
  assert.deepEqual(readFileSync(join(target, 'storage/uploads/audio/sample.wav')), audio);
  assert.equal(readFileSync(join(target, 'storage/uploads/notes/nested/note.txt'), 'utf8'), 'isolated upload\n');
  assert.equal(readFileSync(join(target, 'storage/uploads/empty.bin')).length, 0);
  const actualRows = Object.fromEntries(sq(restoredDb, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;", true)
    .map(({ name }) => [name, Number(sq(restoredDb, `SELECT count(*) FROM "${name.replaceAll('"', '""')}";`))]));
  assert.deepEqual(actualRows, manifest.database.rowCounts, '恢复后所有表行数必须与 manifest 一致');
  assert.equal(JSON.stringify(sourceFingerprint()), before, '默认恢复不得修改源库');
  const keyNames = ['Stage', 'StageAcceptanceItem', 'Resource', 'StudySession', 'EvidenceAttachment', 'AudioAsset', 'AppMigration'];
  console.log(`ROWS ${keyNames.map((name) => `${name}=${actualRows[name]}`).join(' ')} tables=${Object.keys(actualRows).length} total=${Object.values(actualRows).reduce((a, b) => a + b, 0)}`);
  console.log('INTEGRITY source=ok restored=ok FOREIGN_KEYS source=0 restored=0');

  const negativeDir = join(root, 'negative');
  mkdirSync(negativeDir);
  const noSidecar = join(negativeDir, 'no-sidecar.tar');
  writeFileSync(noSidecar, readFileSync(bundle));
  expectReject('missing overall checksum', noSidecar, /整体 checksum 缺失/);
  const tampered = rewrite(bundle, join(negativeDir, 'tampered.tar'), (items) => {
    const entry = items.find((item) => item.name === 'storage/uploads/audio/sample.wav');
    entry.data[0] ^= 0xff;
    return items;
  });
  expectReject('payload sha256 mismatch', tampered, /sha256 不匹配/);
  expectReject('missing manifest', rewrite(bundle, join(negativeDir, 'no-manifest.tar'), (items) => items.filter((item) => item.name !== 'manifest.json')), /缺少 manifest/);
  expectReject('missing checksum list', rewrite(bundle, join(negativeDir, 'no-checksums.tar'), (items) => items.filter((item) => item.name !== 'checksums.sha256')), /缺少 checksums/);
  expectReject('missing payload file', rewrite(bundle, join(negativeDir, 'no-payload.tar'), (items) => items.filter((item) => item.name !== 'storage/uploads/empty.bin')), /完全一致/);
  for (const [label, name, type, linkname, pattern] of [
    ['absolute tar path', '/tmp/ielts-escape.txt', '0', '', /拒绝绝对路径/],
    ['parent traversal tar path', '../ielts-escape.txt', '0', '', /拒绝路径穿越/],
    ['symlink tar entry', 'storage/uploads/evil-link', '2', '/tmp/ielts-target', /拒绝非普通文件/],
    ['hardlink tar entry', 'storage/uploads/evil-hardlink', '1', 'prisma/dev.db', /拒绝非普通文件/],
  ]) {
    const malicious = rewrite(bundle, join(negativeDir, `${label.replaceAll(' ', '-')}.tar`), (items) => [...items, { name, type, linkname, data: '' }]);
    expectReject(label, malicious, pattern);
  }
  expectReject('entry size limit', bundle, /单文件上限/, { IELTS_BACKUP_MAX_FILE_BYTES: '1' });
  const badFk = replaceDatabase(bundle, join(negativeDir, 'bad-fk.tar'), (db) => {
    sq(db, "PRAGMA foreign_keys=OFF; UPDATE \"StudySession\" SET \"taskId\"='missing-task' WHERE \"id\"='session-1';");
  });
  expectReject('foreign key violation', badFk, /foreign_key_check 存在违规/);
  const alteredChecksum = 'deadbeefdeadbeef';
  assert.notEqual(alteredChecksum, migrationChecksums.get('v2.7'), '负向用例必须构造非权威 checksum');
  const badVersion = replaceDatabase(bundle, join(negativeDir, 'bad-version.tar'), (db) => {
    sq(db, `UPDATE "AppMigration" SET "checksum"='${alteredChecksum}' WHERE "version"='v2.7';`);
  });
  expectReject('AppMigration authoritative checksum mismatch', badVersion, /AppMigration checksum 与迁移脚本权威值不一致/);
  const corrupt = replaceDatabase(bundle, join(negativeDir, 'corrupt.tar'), (db) => {
    const bytes = readFileSync(db); bytes[100] ^= 0xff; writeFileSync(db, bytes);
  });
  expectReject('SQLite integrity/corruption', corrupt, /SQLite 校验失败|integrity_check 失败/);
  assert.equal(existsSync(join(root, 'ielts-escape.txt')), false, '恶意路径不得逃逸出暂存区');

  const symlinkPath = join(uploads, 'source-link.wav');
  symlinkSync(join(uploads, 'audio/sample.wav'), symlinkPath);
  const bundleCount = readdirSync(backupDir).filter((name) => name.endsWith('.tar')).length;
  run('/bin/bash', [backupScript], {
    expectFailure: true, label: 'backup source symlink', pattern: /拒绝 symlink/,
    env: { IELTS_DB_PATH: sourceDb, IELTS_UPLOADS_DIR: uploads, IELTS_BACKUP_DIR: backupDir },
  });
  rmSync(symlinkPath);
  assert.equal(readdirSync(backupDir).filter((name) => name.endsWith('.tar')).length, bundleCount, '失败备份不得发布 bundle');
  negativeCount += 1;
  console.log('NEGATIVE backup source symlink: rejected');

  const uploadsGuardSource = join(root, 'uploads-guard-source');
  const uploadsGuardDb = join(uploadsGuardSource, 'prisma/dev.db');
  const uploadsGuardPath = join(uploadsGuardSource, 'storage/uploads');
  const uploadsGuardBackups = join(root, 'uploads-guard-backups');
  mkdirSync(join(uploadsGuardSource, 'prisma'), { recursive: true });
  mkdirSync(join(uploadsGuardSource, 'storage'), { recursive: true });
  mkdirSync(uploadsGuardBackups, { recursive: true });
  copyFileSync(sourceDb, uploadsGuardDb);
  const uploadsGuardEnv = { IELTS_DB_PATH: uploadsGuardDb, IELTS_UPLOADS_DIR: uploadsGuardPath, IELTS_BACKUP_DIR: uploadsGuardBackups };
  run('/bin/bash', [backupScript], {
    expectFailure: true, label: 'backup missing uploads', pattern: /目录不存在：.*storage\/uploads/, env: uploadsGuardEnv,
  });
  assert.deepEqual(readdirSync(uploadsGuardBackups), [], 'uploads 缺失时不得发布任何备份产物');
  console.log('NEGATIVE backup missing uploads: rejected');

  mkdirSync(uploadsGuardPath, { mode: 0o700 });
  const emptyBackup = run('/bin/bash', [backupScript], { env: uploadsGuardEnv });
  process.stdout.write(emptyBackup.stdout);
  const emptyBundle = join(uploadsGuardBackups, readdirSync(uploadsGuardBackups).find((name) => name.endsWith('.tar')));
  const emptyManifest = JSON.parse(decoder.decode(readTar(emptyBundle).find((entry) => entry.name === 'manifest.json').data));
  assert.deepEqual(emptyManifest.uploads, { path: 'storage/uploads', empty: true, fileCount: 0 });
  assert.deepEqual(Object.keys(emptyManifest.files), ['prisma/dev.db'], '合法空 uploads 备份只能包含数据库 payload');
  const emptyRestored = run('/bin/bash', [restoreScript, emptyBundle]);
  process.stdout.write(emptyRestored.stdout);
  const emptyTarget = emptyRestored.stdout.match(/^RESTORED target=(.+)$/m)?.[1];
  assert.ok(emptyTarget?.startsWith('/tmp/ielts-restore-'), '空 uploads 也必须恢复到隔离 /tmp 目录');
  const restoredUploads = join(emptyTarget, 'storage/uploads');
  assert.equal(existsSync(restoredUploads), true, '空 uploads 目录必须被明确恢复');
  assert.deepEqual(readdirSync(restoredUploads), [], '恢复后的 uploads 必须仍为空目录');
  assert.equal(sq(join(emptyTarget, 'prisma/dev.db'), 'PRAGMA integrity_check;'), 'ok');
  rmSync(emptyTarget, { recursive: true, force: true });
  console.log('UPLOADS_GUARD missing=rejected empty=restored backup_source_guards=2');

  const overwriteTarget = join(root, 'overwrite');
  mkdirSync(join(overwriteTarget, 'prisma'), { recursive: true });
  mkdirSync(join(overwriteTarget, 'storage/uploads'), { recursive: true });
  const oldDb = join(overwriteTarget, 'prisma/dev.db');
  sq(oldDb, 'CREATE TABLE "OldMarker"("value" TEXT); INSERT INTO "OldMarker" VALUES(\'old-user-data\');');
  writeFileSync(join(overwriteTarget, 'storage/uploads/old.txt'), 'old upload\n');
  const oldFingerprint = JSON.stringify([sha(readFileSync(oldDb)), sha(readFileSync(join(overwriteTarget, 'storage/uploads/old.txt')))]);
  run('/bin/bash', [restoreScript, bundle, '--target', overwriteTarget], { expectFailure: true, label: 'nonempty target without overwrite', pattern: /必须显式 --overwrite/ });
  run('/bin/bash', [restoreScript, bundle, '--target', overwriteTarget, '--overwrite'], { input: 'n\n', expectFailure: true, label: 'overwrite confirmation no', pattern: /目标未改动/ });
  run('/bin/bash', [restoreScript, bundle, '--target', overwriteTarget, '--overwrite'], { input: 'y\nwrong\n', expectFailure: true, label: 'overwrite confirmation wrong', pattern: /目标未改动/ });
  assert.equal(JSON.stringify([sha(readFileSync(oldDb)), sha(readFileSync(join(overwriteTarget, 'storage/uploads/old.txt')))]), oldFingerprint, '拒绝覆盖时旧数据必须逐字节不变');
  negativeCount += 3;
  console.log('NEGATIVE overwrite guards: rejected without changes (3 cases)');
  const overwritten = run('/bin/bash', [restoreScript, bundle, '--target', overwriteTarget, '--overwrite'], { input: 'y\nRESTORE\n' });
  process.stdout.write(overwritten.stdout);
  const safety = overwritten.stdout.match(/^SAFETY=(.+)$/m)?.[1];
  assert.ok(safety?.startsWith(join(overwriteTarget, '.ielts-before-restore-')), '覆盖前必须保留 DB+uploads 安全网');
  assert.equal(sq(oldDb, 'PRAGMA integrity_check;'), 'ok');
  assert.equal(sq(join(safety, 'prisma/dev.db'), 'SELECT value FROM "OldMarker";'), 'old-user-data');
  assert.equal(readFileSync(join(safety, 'storage/uploads/old.txt'), 'utf8'), 'old upload\n');
  assert.deepEqual(readFileSync(join(overwriteTarget, 'storage/uploads/audio/sample.wav')), audio);
  const rolledBack = run('/bin/bash', [restoreScript, '--rollback', safety, '--target', overwriteTarget], { input: 'y\nRESTORE\n' });
  process.stdout.write(rolledBack.stdout);
  assert.equal(sq(oldDb, 'SELECT value FROM "OldMarker";'), 'old-user-data');
  assert.equal(readFileSync(join(overwriteTarget, 'storage/uploads/old.txt'), 'utf8'), 'old upload\n');
  assert.equal(existsSync(join(overwriteTarget, 'storage/uploads/audio/sample.wav')), false);
  console.log('ROLLBACK explicit overwrite safety restore=ok');

  assert.equal(JSON.stringify(sourceFingerprint()), before, '整个演练不得修改隔离源库');
  console.log(`PASS backup+restore drill; negative_cases=${negativeCount}; bundle_sha256=${archiveHash}; integrity=ok; foreign_keys=0; restored_rows=${Object.values(actualRows).reduce((a, b) => a + b, 0)}; uploads_missing=rejected; uploads_empty=restored; backup_source_guards=2`);
  if (!keep) {
    rmSync(target, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    console.log('CLEANUP /tmp restore and drill directories removed');
  } else console.log(`KEEP ${root}`);
} catch (error) {
  console.error(error.stack || error);
  if (keep) console.error(`KEEP_FAILED ${root}`);
  else rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
}
