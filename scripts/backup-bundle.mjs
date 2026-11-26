#!/usr/bin/env node
/** Dependency-free, fail-closed SQLite + uploads backup bundle helper. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync,
  fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQLITE3 = process.env.IELTS_SQLITE3 || '/usr/bin/sqlite3';
const DATABASE_PATH = 'prisma/dev.db';
const UPLOADS_PATH = 'storage/uploads';
const MANIFEST_PATH = 'manifest.json';
const CHECKSUMS_PATH = 'checksums.sha256';
const FORMAT_VERSION = 1;
const BLOCK = 512;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function positiveLimit(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
const limits = {
  bundle: positiveLimit('IELTS_BACKUP_MAX_BUNDLE_BYTES', 512 * 1024 * 1024),
  file: positiveLimit('IELTS_BACKUP_MAX_FILE_BYTES', 256 * 1024 * 1024),
  total: positiveLimit('IELTS_BACKUP_MAX_TOTAL_BYTES', 1024 * 1024 * 1024),
  entries: positiveLimit('IELTS_BACKUP_MAX_ENTRIES', 10_000),
};

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function hashFile(path) {
  const hash = createHash('sha256');
  const info = assertRegular(path);
  if (info.size > limits.bundle) fail(`文件超过 bundle 上限：${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (offset < info.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!count) fail(`读取时文件缩小：${path}`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally { closeSync(fd); }
  return { size: info.size, sha256: hash.digest('hex') };
}
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function quoteIdentifier(name) { return `"${name.replaceAll('"', '""')}"`; }
function sqlite(db, sql) {
  try {
    return execFileSync(SQLITE3, ['-readonly', '-batch', '-noheader', '-list', db, sql], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    fail(`SQLite 校验失败：${error.stderr?.toString().trim() || error.message}`);
  }
}
function sqliteJson(db, sql) {
  try {
    const output = execFileSync(SQLITE3, ['-readonly', '-batch', '-noheader', '-json', db, sql], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch (error) {
    fail(`SQLite 元数据读取失败：${error.stderr?.toString().trim() || error.message}`);
  }
}
function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
function migrationScripts() {
  return readdirSync(join(projectRoot(), 'scripts/migrations'))
    .map((name) => ({ name, version: name.match(/^v(\d+(?:\.\d+)*)\.mjs$/)?.[1] }))
    .filter((entry) => entry.version)
    .sort((a, b) => {
      const aa = a.version.split('.').map(Number), bb = b.version.split('.').map(Number);
      for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
        const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
        if (diff) return diff;
      }
      return 0;
    })
    .map((entry) => ({ name: entry.name, version: `v${entry.version}` }));
}
function projectVersions() {
  const root = projectRoot();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const constants = readFileSync(join(root, 'src/lib/constants.ts'), 'utf8');
  const schema = constants.match(/export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!schema) fail('无法从 src/lib/constants.ts 读取 SCHEMA_VERSION');
  return { appVersion: pkg.version, schemaVersion: Number(schema[1]), migrations: migrationScripts().map((entry) => entry.version) };
}
let migrationChecksumCache;
function authoritativeMigrationChecksums() {
  if (migrationChecksumCache) return migrationChecksumCache;
  const scripts = migrationScripts();
  if (!scripts.length) fail('未找到迁移脚本，拒绝校验 AppMigration');
  const checksums = new Map();
  for (const { name, version } of scripts) {
    let output;
    try {
      output = execFileSync(process.execPath, [join(projectRoot(), 'scripts/migrations', name), '--checksum-only'], {
        cwd: projectRoot(), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, DATABASE_URL: 'file:/tmp/ielts-migration-checksum-only-no-db.db' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(`读取迁移脚本权威 checksum 失败：${name}：${error.message}；${error.stderr?.toString().trim() || '无 stderr'}`);
    }
    if (!/^[a-f0-9]{16,128}\n$/.test(output)) fail(`迁移脚本权威 checksum 输出非法：${name}`);
    checksums.set(version, output.slice(0, -1));
  }
  migrationChecksumCache = checksums;
  return checksums;
}
function validateMigrationChecksums(rows, label) {
  const authoritative = authoritativeMigrationChecksums();
  for (const row of rows) {
    const expected = authoritative.get(row.version);
    if (!expected) fail(`${label} 找不到权威迁移脚本：${row.version}`);
    if (row.checksum !== expected) {
      fail(`${label} checksum 与迁移脚本权威值不一致：${row.version}（库=${row.checksum}，脚本=${expected}）`);
    }
  }
}

function safeRelativePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) {
    fail(`拒绝不安全路径：${JSON.stringify(name)}`);
  }
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name)) fail(`拒绝绝对路径：${name}`);
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`拒绝路径穿越或非法段：${name}`);
  if (parts.length > 32 || encoder.encode(name).length > 1024) fail(`路径过长：${name}`);
  let decoded;
  try { decoded = decoder.decode(encoder.encode(name)); } catch { fail(`路径不是合法 UTF-8：${name}`); }
  if (decoded !== name) fail(`路径编码不一致：${name}`);
  return name;
}
function payloadPath(name) {
  safeRelativePath(name);
  if (name !== DATABASE_PATH && !name.startsWith(`${UPLOADS_PATH}/`)) {
    fail(`bundle 含不允许的数据路径：${name}`);
  }
  return name;
}
function assertRegular(path, label = path) {
  let info;
  try { info = lstatSync(path); } catch { fail(`文件不存在：${label}`); }
  if (!info.isFile() || info.isSymbolicLink()) fail(`拒绝非普通文件或 symlink：${label}`);
  if (info.size > limits.file) fail(`文件超过单文件上限（${limits.file} 字节）：${label}`);
  return info;
}
function copyRegular(source, destination) {
  assertRegular(source);
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let total = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > limits.file) fail(`文件超过单文件上限：${source}`);
      writeSync(output, buffer, 0, count);
    }
    fsyncSync(output);
  } finally { closeSync(input); closeSync(output); }
}
function walkFiles(root, prefix = '') {
  const files = [];
  let info;
  try { info = lstatSync(root); } catch (error) {
    if (error.code === 'ENOENT') fail(`目录不存在：${root}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`拒绝非目录或 symlink：${root}`);
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelativePath(name);
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`拒绝 symlink：${name}`);
    if (stat.isDirectory()) files.push(...walkFiles(path, name));
    else if (stat.isFile()) files.push(name);
    else fail(`拒绝特殊文件：${name}`);
  }
  return files;
}
function copyUploads(source, stage) {
  const files = walkFiles(source, UPLOADS_PATH);
  const destination = join(stage, UPLOADS_PATH);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of files) {
    payloadPath(name);
    const target = join(stage, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyRegular(join(source, relative(UPLOADS_PATH, name)), target);
  }
}

function captureDatabase(db) {
  assertRegular(db);
  const integrity = sqlite(db, 'PRAGMA integrity_check;');
  if (integrity !== 'ok') fail(`SQLite integrity_check 失败：${integrity}`);
  const foreignKeys = sqlite(db, 'PRAGMA foreign_key_check;');
  if (foreignKeys) fail(`SQLite foreign_key_check 存在违规：${foreignKeys}`);
  const schemaRows = sqliteJson(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;");
  const schemaFingerprint = sha256(JSON.stringify(schemaRows));
  const sqliteUserVersion = Number(sqlite(db, 'PRAGMA user_version;'));
  const tables = sqliteJson(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
  const rowCounts = {};
  for (const { name } of tables) rowCounts[name] = Number(sqlite(db, `SELECT count(*) FROM ${quoteIdentifier(name)};`));
  const appMigrations = sqliteJson(db, 'SELECT version,checksum,appliedAt,note FROM "AppMigration" ORDER BY version;');
  if (!Array.isArray(appMigrations) || appMigrations.length === 0) fail('AppMigration 版本账本为空，拒绝备份');
  const versions = new Set();
  for (const row of appMigrations) {
    if (typeof row.version !== 'string' || !row.version || versions.has(row.version)) fail('AppMigration 版本无效或重复');
    versions.add(row.version);
    if (row.checksum !== null && (typeof row.checksum !== 'string' || !/^[a-f0-9]{1,128}$/i.test(row.checksum))) {
      fail(`AppMigration checksum 无效：${row.version}`);
    }
    if (typeof row.appliedAt !== 'string' || Number.isNaN(Date.parse(row.appliedAt))) fail(`AppMigration appliedAt 无效：${row.version}`);
  }
  validateMigrationChecksums(appMigrations, 'AppMigration');
  return { integrityCheck: 'ok', foreignKeyViolations: 0, schemaFingerprint, sqliteUserVersion, rowCounts, appMigrations };
}
function databaseMetadata(db, manifest) {
  const actual = captureDatabase(db);
  const expected = manifest.database;
  for (const key of ['integrityCheck', 'foreignKeyViolations', 'schemaFingerprint', 'sqliteUserVersion']) {
    if (actual[key] !== expected[key]) fail(`数据库 ${key} 与 manifest 不一致`);
  }
  if (JSON.stringify(actual.rowCounts) !== JSON.stringify(expected.rowCounts)) fail('数据库表行数与 manifest 不一致');
  const normalize = (rows) => rows.map((row) => ({
    version: row.version, checksum: row.checksum ?? null,
    appliedAt: new Date(row.appliedAt).toISOString(), note: row.note ?? null,
  }));
  if (JSON.stringify(normalize(actual.appMigrations)) !== JSON.stringify(normalize(expected.appMigrations))) {
    fail('AppMigration 版本/校验和与 manifest 不一致');
  }
  return actual;
}
function verifyInstalledVersions(manifest, allowMismatch) {
  const installed = projectVersions();
  const migrationList = manifest.appMigrations.map((row) => row.version);
  const mismatch = installed.appVersion !== manifest.appVersion
    || installed.schemaVersion !== manifest.schemaVersion
    || JSON.stringify(installed.migrations) !== JSON.stringify(migrationList);
  if (mismatch && !allowMismatch) {
    fail(`版本不兼容：bundle app=${manifest.appVersion}/schema=${manifest.schemaVersion}/migrations=${migrationList.join(',')}；当前 app=${installed.appVersion}/schema=${installed.schemaVersion}/migrations=${installed.migrations.join(',')}。回滚到旧版本需使用匹配旧代码；确需跳过时显式加 --allow-version-mismatch`);
  }
  if (mismatch) console.error('警告：已显式允许 bundle 与当前代码版本不一致，请勿直接启动当前应用。');
}

function makeManifest(stage, createdAt, sourceDb) {
  const versions = projectVersions();
  const db = join(stage, DATABASE_PATH);
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  copyRegular(sourceDb, db);
  const database = captureDatabase(db);
  const uploadFiles = walkFiles(join(stage, UPLOADS_PATH), UPLOADS_PATH);
  const paths = [DATABASE_PATH, ...uploadFiles].sort();
  if (paths.length + 2 > limits.entries) fail('bundle 条目数超过上限');
  const files = {};
  let total = 0;
  for (const name of paths) {
    payloadPath(name);
    const info = hashFile(join(stage, name));
    total += info.size;
    if (info.size > limits.file) fail(`文件超过单文件上限：${name}`);
    files[name] = info;
  }
  if (total > limits.total) fail('bundle 解包总大小超过上限');
  return {
    formatVersion: FORMAT_VERSION, createdAt, appVersion: versions.appVersion,
    schemaVersion: versions.schemaVersion, database: { path: DATABASE_PATH, ...database },
    uploads: { path: UPLOADS_PATH, empty: uploadFiles.length === 0, fileCount: uploadFiles.length },
    appMigrations: database.appMigrations, totalBytes: total, fileCount: paths.length, files,
  };
}

function tarHeader(name, size) {
  safeRelativePath(name);
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 100) {
    const parts = name.split('/');
    let split = -1;
    for (let i = 1; i < parts.length; i += 1) {
      const candidate = parts.slice(0, i).join('/');
      if (encoder.encode(candidate).length <= 155 && encoder.encode(parts.slice(i).join('/')).length <= 100) split = i;
    }
    if (split < 0) fail(`tar 路径过长：${name}`);
    return tarHeaderWithPrefix(parts.slice(split).join('/'), parts.slice(0, split).join('/'), size);
  }
  return tarHeaderWithPrefix(name, '', size);
}
function tarHeaderWithPrefix(name, prefix, size) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write('0000600\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}
function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}
function appendTarFile(fd, name, source) {
  const info = assertRegular(source);
  const header = tarHeader(name, info.size);
  writeAll(fd, header);
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    while (true) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > info.size) fail(`备份过程中文件增长：${name}`);
      writeAll(fd, buffer.subarray(0, count));
    }
  } finally { closeSync(input); }
  if (total !== info.size) fail(`备份过程中文件缩小：${name}`);
  const padding = (BLOCK - (info.size % BLOCK)) % BLOCK;
  if (padding) writeAll(fd, Buffer.alloc(padding));
}
function checksumText(manifest, manifestBytes) {
  const entries = Object.entries(manifest.files).map(([name, info]) => [name, info.sha256]);
  entries.push([MANIFEST_PATH, sha256(manifestBytes)]);
  entries.sort(([a], [b]) => compareText(a, b));
  return `${entries.map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`;
}
function createBundle(options) {
  const stage = mkdtempSync('/tmp/ielts-backup-create-');
  try {
    chmodSync(stage, 0o700);
    copyUploads(options.uploads, stage);
    const manifest = makeManifest(stage, options.createdAt, options.db);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('manifest 超过大小上限');
    const checksums = Buffer.from(checksumText(manifest, manifestBytes));
    const output = options.output;
    if (existsSync(output)) fail(`输出已存在，拒绝覆盖：${output}`);
    const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      for (const name of Object.keys(manifest.files).sort()) appendTarFile(fd, name, join(stage, name));
      writeAll(fd, tarHeader(MANIFEST_PATH, manifestBytes.length));
      writeAll(fd, manifestBytes);
      const manifestPadding = (BLOCK - (manifestBytes.length % BLOCK)) % BLOCK;
      if (manifestPadding) writeAll(fd, Buffer.alloc(manifestPadding));
      writeAll(fd, tarHeader(CHECKSUMS_PATH, checksums.length));
      writeAll(fd, checksums);
      const checksumPadding = (BLOCK - (checksums.length % BLOCK)) % BLOCK;
      if (checksumPadding) writeAll(fd, Buffer.alloc(checksumPadding));
      writeAll(fd, Buffer.alloc(BLOCK * 2));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const archive = hashFile(output);
    if (archive.size > limits.bundle) fail('bundle 超过整体大小上限');
    const sidecar = `${output}.sha256`;
    const checksumName = options.checksum_name || basename(output);
    writeFileSync(sidecar, `${archive.sha256}  ${checksumName}\n`, { flag: 'wx', mode: 0o600 });
    // 发布前按真实恢复路径再完整自检一次；临时输出名与最终名不同，因此显式传最终名。
    const verifyState = join(stage, '.verify-state.json');
    try {
      prepare({ bundle: output, checksums: sidecar, state: verifyState, allow_version_mismatch: true, bundle_name: checksumName });
    } finally { cleanupState(verifyState); rmSync(verifyState, { force: true }); }
    console.log(`MANIFEST format=${FORMAT_VERSION} app=${manifest.appVersion} schema=${manifest.schemaVersion} migrations=${manifest.appMigrations.map((row) => row.version).join(',')}`);
    console.log(`FILES ${manifest.fileCount} bytes=${manifest.totalBytes}`);
    console.log(`UPLOADS files=${manifest.uploads.fileCount} empty=${manifest.uploads.empty}`);
    console.log(`ARCHIVE_SHA256 ${archive.sha256}`);
    console.log(`KEY_ROWS ${Object.entries(manifest.database.rowCounts).filter(([name]) => ['stage', 'stageacceptanceitem', 'resource', 'studysession', 'appmigration'].includes(name.toLowerCase())).map(([name, count]) => `${name}=${count}`).join(' ')}`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function verifyOverallChecksum(bundle, checksumFile, expectedName = basename(bundle)) {
  assertRegular(bundle, 'bundle');
  assertRegular(checksumFile, '整体 checksum 文件');
  if (statSync(checksumFile).size > 4096) fail('整体 checksum 文件过大');
  const text = readFileSync(checksumFile, 'utf8');
  const match = text.match(/^([a-f0-9]{64})  (.+)\n$/);
  if (!match || match[2] !== expectedName) fail('整体 checksum 文件格式或文件名不匹配');
  const actual = hashFile(bundle);
  if (actual.sha256 !== match[1]) fail('bundle 整体 sha256 不匹配，拒绝解包');
  return actual;
}
function parseTarNumber(field, label) {
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]+$/.test(text)) fail(`tar ${label} 字段非法`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} 越界`);
  return value;
}
function readAt(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, position + offset);
    if (!count) fail('tar 文件被截断');
    offset += count;
  }
  return buffer;
}
function parseTar(bundle) {
  const info = assertRegular(bundle, 'bundle');
  if (info.size > limits.bundle || info.size % BLOCK !== 0) fail('bundle 大小非法或超过上限');
  const fd = openSync(bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
  const entries = [];
  const names = new Set();
  let position = 0;
  let total = 0;
  try {
    while (position + BLOCK <= info.size) {
      const header = readAt(fd, BLOCK, position);
      if (header.every((byte) => byte === 0)) {
        const second = readAt(fd, BLOCK, position + BLOCK);
        if (!second.every((byte) => byte === 0)) fail('tar 结束块不完整');
        position += BLOCK * 2;
        while (position < info.size) {
          if (!readAt(fd, BLOCK, position).every((byte) => byte === 0)) fail('tar 结束后存在非零尾部数据');
          position += BLOCK;
        }
        return entries;
      }
      const type = String.fromCharCode(header[156]);
      if (type !== '0' && type !== '\0') fail(`tar 拒绝非普通文件条目（type=${JSON.stringify(type)}）；symlink/hardlink/设备/目录均不允许`);
      const magic = header.subarray(257, 263).toString('ascii').replace(/\0$/, '');
      if (magic !== 'ustar') fail('tar 不是受支持的 ustar 格式');
      const storedChecksum = parseTarNumber(header.subarray(148, 156), 'checksum');
      let actualChecksum = 0;
      for (let i = 0; i < BLOCK; i += 1) actualChecksum += i >= 148 && i < 156 ? 0x20 : header[i];
      if (storedChecksum !== actualChecksum) fail('tar header checksum 不匹配');
      let name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
      const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, '');
      if (prefix) name = `${prefix}/${name}`;
      safeRelativePath(name);
      if (header.subarray(157, 257).some((byte) => byte !== 0)) fail('tar 普通文件不允许 linkname');
      if (names.has(name)) fail(`tar 条目重复：${name}`);
      names.add(name);
      const size = parseTarNumber(header.subarray(124, 136), 'size');
      if (size > limits.file) fail(`tar 条目超过单文件上限：${name}`);
      total += size;
      if (total > limits.total) fail('tar 解包总大小超过上限');
      entries.push({ name, size, offset: position + BLOCK, type: 'file' });
      if (entries.length > limits.entries) fail('tar 条目数超过上限');
      position += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
    fail('tar 缺少结束块');
  } finally { closeSync(fd); }
}
function readTarEntry(bundle, entry) {
  if (entry.size > MAX_MANIFEST_BYTES) fail(`元数据条目过大：${entry.name}`);
  const fd = openSync(bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readAt(fd, entry.size, entry.offset); } finally { closeSync(fd); }
}
function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest 不是对象');
  if (value.formatVersion !== FORMAT_VERSION || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) fail('manifest format/schemaVersion 无效');
  if (typeof value.appVersion !== 'string' || !value.appVersion) fail('manifest appVersion 缺失');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) fail('manifest createdAt 无效');
  if (!value.database || value.database.path !== DATABASE_PATH) fail('manifest 数据库路径无效');
  if (value.database.integrityCheck !== 'ok' || value.database.foreignKeyViolations !== 0) fail('manifest 数据库校验状态无效');
  if (!isHash(value.database.schemaFingerprint) || !Number.isSafeInteger(value.database.sqliteUserVersion)) fail('manifest SQLite schema 元数据无效');
  if (!value.database.rowCounts || typeof value.database.rowCounts !== 'object' || Array.isArray(value.database.rowCounts)) fail('manifest 行数缺失');
  for (const [table, count] of Object.entries(value.database.rowCounts)) {
    if (!table || !Number.isSafeInteger(count) || count < 0) fail(`manifest 行数无效：${table}`);
  }
  if (!Array.isArray(value.appMigrations) || value.appMigrations.length === 0 || JSON.stringify(value.appMigrations) !== JSON.stringify(value.database.appMigrations)) fail('manifest AppMigration 版本缺失或不一致');
  const versions = new Set();
  for (const row of value.appMigrations) {
    if (!row || typeof row.version !== 'string' || !row.version || versions.has(row.version)) fail('manifest AppMigration 版本无效或重复');
    versions.add(row.version);
    if (row.checksum !== null && (typeof row.checksum !== 'string' || !/^[a-f0-9]{1,128}$/i.test(row.checksum))) fail('manifest migration checksum 无效');
    if (typeof row.appliedAt !== 'string' || Number.isNaN(Date.parse(row.appliedAt))) fail('manifest migration appliedAt 无效');
  }
  validateMigrationChecksums(value.appMigrations, 'manifest AppMigration');
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) fail('manifest 文件清单缺失');
  if (!Object.hasOwn(value.files, DATABASE_PATH)) fail('manifest 缺少 SQLite 数据库');
  const uploadCount = Object.keys(value.files).filter((name) => name.startsWith(`${UPLOADS_PATH}/`)).length;
  if (!value.uploads || value.uploads.path !== UPLOADS_PATH
    || typeof value.uploads.empty !== 'boolean' || !Number.isSafeInteger(value.uploads.fileCount)
    || value.uploads.fileCount !== uploadCount || value.uploads.empty !== (uploadCount === 0)) {
    fail('manifest uploads 空目录标记或文件数无效');
  }
  let total = 0;
  for (const [name, info] of Object.entries(value.files)) {
    payloadPath(name);
    if (!info || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > limits.file || !isHash(info.sha256)) fail(`manifest 文件元数据无效：${name}`);
    total += info.size;
  }
  if (total > limits.total || Object.keys(value.files).length + 2 > limits.entries) fail('manifest 文件清单超过上限');
  if (value.totalBytes !== total || value.fileCount !== Object.keys(value.files).length) fail('manifest 总大小/文件数不一致');
  return value;
}
function parseChecksums(bytes, manifest, manifestBytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) fail('checksums 文件过大');
  const text = decoder.decode(bytes);
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  const actual = lines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) fail('checksums 文件存在非法行');
    safeRelativePath(match[2]);
    return [match[2], match[1]];
  }).sort(([a], [b]) => compareText(a, b));
  const expected = Object.entries(manifest.files).map(([name, info]) => [name, info.sha256]);
  expected.push([MANIFEST_PATH, sha256(manifestBytes)]);
  expected.sort(([a], [b]) => compareText(a, b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('checksums 文件清单缺失、重复或与 manifest 不一致');
}
function ensurePrivateDirectory(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`拒绝非目录或 symlink：${path}`);
}
function extractVerifiedFile(bundle, entry, stage, expected) {
  payloadPath(entry.name);
  const target = join(stage, entry.name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const input = openSync(bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    let remaining = entry.size;
    while (remaining) {
      const wanted = Math.min(buffer.length, remaining);
      const chunk = readAt(input, wanted, entry.offset + total);
      hash.update(chunk);
      writeAll(output, chunk);
      total += wanted;
      remaining -= wanted;
    }
    fsyncSync(output);
  } finally { closeSync(input); closeSync(output); }
  if (total !== expected.size || hash.digest('hex') !== expected.sha256) fail(`文件大小/sha256 不匹配：${entry.name}`);
}
function verifyTree(stage, manifest) {
  const actual = walkFiles(stage).sort();
  const expected = [...Object.keys(manifest.files), MANIFEST_PATH, CHECKSUMS_PATH].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('暂存区文件清单与 manifest/checksums 不一致');
  for (const [name, info] of Object.entries(manifest.files)) {
    const path = join(stage, name);
    assertRegular(path, name);
    const actualInfo = hashFile(path);
    if (actualInfo.size !== info.size || actualInfo.sha256 !== info.sha256) fail(`暂存文件校验失败：${name}`);
  }
}
function prepare(options) {
  const archive = verifyOverallChecksum(options.bundle, options.checksums, options.bundle_name);
  const entries = parseTar(options.bundle);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestBytes = readTarEntry(options.bundle, byName.get(MANIFEST_PATH) ?? fail('bundle 缺少 manifest.json'));
  const checksumBytes = readTarEntry(options.bundle, byName.get(CHECKSUMS_PATH) ?? fail('bundle 缺少 checksums.sha256'));
  const manifest = validateManifest(JSON.parse(decoder.decode(manifestBytes)));
  parseChecksums(checksumBytes, manifest, manifestBytes);
  const expectedNames = [...Object.keys(manifest.files), MANIFEST_PATH, CHECKSUMS_PATH].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) fail('tar 实际条目与 manifest/checksums 文件清单缺一不可且必须完全一致');
  const stage = mkdtempSync('/tmp/ielts-restore-stage-');
  try {
    chmodSync(stage, 0o700);
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      if (entry.name === MANIFEST_PATH || entry.name === CHECKSUMS_PATH) {
        const bytes = entry.name === MANIFEST_PATH ? manifestBytes : checksumBytes;
        writeFileSync(join(stage, entry.name), bytes, { flag: 'wx', mode: 0o600 });
      } else extractVerifiedFile(options.bundle, entry, stage, manifest.files[entry.name]);
    }
    verifyTree(stage, manifest);
    const database = databaseMetadata(join(stage, DATABASE_PATH), manifest);
    verifyInstalledVersions(manifest, options.allow_version_mismatch);
    const state = {
      formatVersion: FORMAT_VERSION, stageDir: stage, bundle: resolve(options.bundle),
      checksums: resolve(options.checksums), archiveSha256: archive.sha256,
      createdAt: new Date().toISOString(), manifest,
    };
    writeFileSync(options.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    console.log('VERIFIED manifest/checksums/tar-paths=ok');
    console.log(`VERIFIED archive_sha256=${archive.sha256}`);
    console.log('VERIFIED sqlite_integrity=ok sqlite_foreign_keys=0');
    console.log(`VERIFIED app=${manifest.appVersion} schema=${manifest.schemaVersion} migrations=${manifest.appMigrations.map((row) => row.version).join(',')}`);
    console.log(`VERIFIED uploads_files=${manifest.uploads.fileCount} uploads_empty=${manifest.uploads.empty}`);
    console.log(`VERIFIED files=${manifest.fileCount} bytes=${manifest.totalBytes} tables=${Object.keys(database.rowCounts).length} rows=${Object.values(database.rowCounts).reduce((a, b) => a + b, 0)}`);
    console.log(`VERIFIED key_rows ${Object.entries(database.rowCounts).filter(([name]) => ['stage', 'stageacceptanceitem', 'resource', 'studysession', 'appmigration'].includes(name.toLowerCase())).map(([name, count]) => `${name}=${count}`).join(' ')}`);
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
function readState(path) {
  assertRegular(path, 'state');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.formatVersion !== FORMAT_VERSION || typeof state.stageDir !== 'string') fail('restore state 无效');
  const stage = resolve(state.stageDir);
  if (dirname(stage) !== '/tmp' || !basename(stage).startsWith('ielts-restore-stage-')) fail('restore stage 不在受控 /tmp 目录');
  ensurePrivateDirectory(stage);
  const manifest = validateManifest(state.manifest);
  verifyTree(stage, manifest);
  databaseMetadata(join(stage, DATABASE_PATH), manifest);
  return { ...state, stageDir: stage, manifest };
}
function isEmptyDirectory(path) { return readdirSync(path).length === 0; }
function checkTarget(target, overwrite) {
  const resolved = resolve(target);
  if (['/', '/tmp', process.env.HOME].includes(resolved)) fail(`拒绝危险恢复目标：${resolved}`);
  if (existsSync(resolved)) {
    ensurePrivateDirectory(resolved);
    if (!overwrite && !isEmptyDirectory(resolved)) fail('默认恢复只能写入新目录/空目录；覆盖现有数据必须显式 --overwrite --target 并二次确认');
  } else {
    const parent = dirname(resolved);
    if (!existsSync(parent)) fail(`目标父目录不存在：${parent}`);
    ensurePrivateDirectory(parent);
    if (overwrite) fail('--overwrite 目标必须已存在');
    mkdirSync(resolved, { mode: 0o700 });
  }
  return resolved;
}
function noSidecars(target) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (pathExists(join(target, `${DATABASE_PATH}${suffix}`))) fail(`目标数据库存在 ${suffix} 残留；请停应用后手工处理，恢复已中止`);
  }
}
function validateDataDirectories(root) {
  for (const name of ['prisma', 'storage']) {
    const path = join(root, name);
    if (pathExists(path)) ensurePrivateDirectory(path);
  }
  const db = join(root, DATABASE_PATH), uploads = join(root, UPLOADS_PATH);
  if (pathExists(db)) {
    const info = lstatSync(db);
    if (!info.isFile() || info.isSymbolicLink()) fail(`拒绝非普通数据库或 symlink：${db}`);
  }
  if (pathExists(uploads)) ensurePrivateDirectory(uploads);
}
function prepareDestinationCopies(stage, manifest, target) {
  const dbDir = join(target, 'prisma');
  const storageDir = join(target, 'storage');
  for (const path of [dbDir, storageDir]) {
    if (existsSync(path)) ensurePrivateDirectory(path);
    else mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const temporaryDb = join(dbDir, `.ielts-restore-db-${process.pid}-${Date.now()}`);
  copyRegular(join(stage, DATABASE_PATH), temporaryDb);
  const dbInfo = hashFile(temporaryDb);
  if (dbInfo.sha256 !== manifest.files[DATABASE_PATH].sha256) fail('恢复数据库临时副本校验失败');
  const temporaryUploads = join(storageDir, `.ielts-restore-uploads-${process.pid}-${Date.now()}`);
  mkdirSync(temporaryUploads, { mode: 0o700 });
  for (const name of Object.keys(manifest.files).filter((name) => name.startsWith(`${UPLOADS_PATH}/`)).sort()) {
    const child = relative(UPLOADS_PATH, name);
    const destination = join(temporaryUploads, child);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyRegular(join(stage, name), destination);
  }
  return { temporaryDb, temporaryUploads };
}
function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function publish(options) {
  const state = readState(options.state);
  if (options.overwrite && !options.confirmed) fail('覆盖模式缺少显式确认');
  const target = checkTarget(options.target, options.overwrite);
  if (inside(state.stageDir, target) || inside(target, state.stageDir)) fail('恢复目标与暂存区重叠');
  noSidecars(target);
  validateDataDirectories(target);
  const copies = prepareDestinationCopies(state.stageDir, state.manifest, target);
  const dbDestination = join(target, DATABASE_PATH);
  const uploadsDestination = join(target, UPLOADS_PATH);
  let safety = null;
  const moved = [];
  let installedDb = false;
  let installedUploads = false;
  try {
    if (options.overwrite && (pathExists(dbDestination) || pathExists(uploadsDestination))) {
      safety = mkdtempSync(join(target, '.ielts-before-restore-'));
      chmodSync(safety, 0o700);
      mkdirSync(join(safety, 'prisma'), { mode: 0o700 });
      mkdirSync(join(safety, 'storage'), { mode: 0o700 });
      for (const [source, saved] of [
        [dbDestination, join(safety, DATABASE_PATH)],
        [uploadsDestination, join(safety, UPLOADS_PATH)],
      ]) {
        if (pathExists(source)) {
          const info = lstatSync(source);
          if (info.isSymbolicLink()) fail(`拒绝覆盖 symlink：${source}`);
          renameSync(source, saved);
          moved.push([saved, source]);
        }
      }
    }
    renameSync(copies.temporaryDb, dbDestination);
    installedDb = true;
    renameSync(copies.temporaryUploads, uploadsDestination);
    installedUploads = true;
    console.log(`RESTORED target=${target}`);
    console.log(`RESTORED database=${dbDestination}`);
    console.log(`RESTORED uploads=${uploadsDestination}`);
    console.log('RESTORED sqlite_integrity=ok sqlite_foreign_keys=0');
    if (safety) console.log(`SAFETY=${safety}`);
  } catch (error) {
    if (installedDb) rmSync(dbDestination, { force: true });
    if (installedUploads) rmSync(uploadsDestination, { recursive: true, force: true });
    for (const [saved, source] of moved.reverse()) if (existsSync(saved)) renameSync(saved, source);
    throw error;
  } finally {
    for (const path of [copies.temporaryDb, copies.temporaryUploads]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}
function rollback(options) {
  if (!options.confirmed) fail('回滚缺少显式确认');
  const target = resolve(options.target);
  const safety = resolve(options.safety);
  if (dirname(safety) !== target || !basename(safety).startsWith('.ielts-before-restore-')) fail('安全网必须是目标目录下的 .ielts-before-restore-* 目录');
  ensurePrivateDirectory(target);
  ensurePrivateDirectory(safety);
  validateDataDirectories(target);
  validateDataDirectories(safety);
  noSidecars(target);
  const failed = mkdtempSync(join(target, '.ielts-failed-restore-'));
  mkdirSync(join(failed, 'prisma'), { mode: 0o700 });
  mkdirSync(join(failed, 'storage'), { mode: 0o700 });
  const displaced = [];
  const installed = [];
  try {
    for (const name of [DATABASE_PATH, UPLOADS_PATH]) {
      const current = join(target, name), saved = join(safety, name);
      const failedCopy = join(failed, name);
      if (pathExists(current)) {
        if (lstatSync(current).isSymbolicLink()) fail(`拒绝回滚 symlink：${current}`);
        renameSync(current, failedCopy);
        displaced.push({ current, failedCopy });
      }
      if (pathExists(saved)) {
        mkdirSync(dirname(current), { recursive: true, mode: 0o700 });
        renameSync(saved, current);
        installed.push({ current, saved });
      }
    }
    console.log(`ROLLED_BACK target=${target} safety=${safety}`);
    console.log(`FAILED_RESTORE=${failed}`);
  } catch (error) {
    for (const { current, saved } of installed.reverse()) {
      if (existsSync(current)) rmSync(current, { recursive: true, force: true });
      if (existsSync(saved)) renameSync(saved, current);
    }
    for (const { current, failedCopy } of displaced.reverse()) {
      if (!existsSync(current) && existsSync(failedCopy)) renameSync(failedCopy, current);
    }
    throw error;
  }
}
function cleanupState(path) {
  if (!existsSync(path)) return;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const stage = resolve(state.stageDir);
    if (dirname(stage) === '/tmp' && basename(stage).startsWith('ielts-restore-stage-')) rmSync(stage, { recursive: true, force: true });
  } catch { /* shell removes the state file; a malformed state never authorizes deletion */ }
}
function parseOptions(args) {
  const options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { options._.push(arg); continue; }
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (['--overwrite', '--confirmed', '--allow-version-mismatch'].includes(flag)) options[flag.slice(2).replaceAll('-', '_')] = true;
    else {
      const value = inline ?? args[++i];
      if (value === undefined) fail(`缺少参数值：${flag}`);
      options[flag.slice(2).replaceAll('-', '_')] = value;
    }
  }
  return options;
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === 'create') {
    if (!options.db || !options.uploads || !options.output) fail('create 需要 --db --uploads --output');
    createBundle({ ...options, createdAt: options.created_at || new Date().toISOString() });
  } else if (command === 'prepare') {
    if (!options.bundle || !options.checksums || !options.state) fail('prepare 需要 --bundle --checksums --state');
    prepare(options);
  } else if (command === 'publish') {
    if (!options.state || !options.target) fail('publish 需要 --state --target');
    publish(options);
  } else if (command === 'rollback') {
    if (!options.safety || !options.target) fail('rollback 需要 --safety --target');
    rollback(options);
  } else if (command === 'cleanup') cleanupState(options.state);
  else fail(`未知命令：${command || '(missing)'}`);
}
try { main(); } catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
