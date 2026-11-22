/**
 * v2.5 本地文件存储：音频上传与录音落盘。
 *
 * 原则（架构不变量）：音频二进制**绝不写 SQLite**，只落 `storage/uploads/`，
 * DB 只存相对路径 + sha256 + 大小 + MIME。所有写盘走 `node:fs`，路径经校验，
 * 防目录穿越。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STORAGE_DIR, UPLOAD_DIR } from './constants';

/** 项目根目录（storage 所在）。 */
function projectRoot(): string {
  return process.cwd();
}

/** storage/uploads 的绝对路径。 */
export function uploadsDir(): string {
  return path.join(projectRoot(), UPLOAD_DIR);
}

/** 确保存储目录存在，返回绝对路径。 */
export function ensureUploadsDir(): string {
  const dir = uploadsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成唯一文件名（日期前缀 + 随机 hex + 扩展名）。 */
export function uniqueFileName(extension: string): string {
  const safe = extension.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${day}-${randomBytes(8).toString('hex')}.${safe || 'bin'}`;
}

/** sha256（hex）。 */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface StoredFile {
  /** 相对 UPLOAD_DIR 的文件名（DB 存这个，可重建绝对路径）。 */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * 把 Buffer 落盘到 storage/uploads，返回存储元数据。
 * 同名冲突由 uniqueFileName 规避；权限 0644（音频非敏感派生，但录音默认私有，调用方自行控制）。
 */
export function writeUploadedFile(buffer: Buffer, extension: string): StoredFile {
  const dir = ensureUploadsDir();
  const name = uniqueFileName(extension);
  const absolutePath = path.join(dir, name);
  writeFileSync(absolutePath, buffer, { flag: 'wx' });
  return {
    relativePath: name,
    absolutePath,
    sizeBytes: buffer.byteLength,
    sha256: sha256Hex(buffer),
  };
}

/** 由相对路径还原绝对路径（防穿越：解析后必须仍在 uploads 目录内）。 */
export function resolveUploadPath(relativePath: string): string {
  const dir = ensureUploadsDir();
  const resolved = path.resolve(dir, relativePath);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error('非法文件路径');
  }
  return resolved;
}

/** 校验文件扩展名是否在允许集合内。 */
export function isAllowedExtension(extension: string): boolean {
  return ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac'].includes(
    extension.replace(/^\./, '').toLowerCase(),
  );
}

/** 从文件名或 MIME 推断扩展名（仅做落盘命名用，非安全边界）。 */
export function extensionFromMime(mimeType: string | null | undefined): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
  };
  return (mimeType && map[mimeType]) || 'bin';
}

/** 删除本地文件（不存在则静默跳过）。 */
export function deleteUploadedFile(relativePath: string): void {
  const { unlinkSync } = require('node:fs') as typeof import('node:fs');
  try {
    unlinkSync(resolveUploadPath(relativePath));
  } catch {
    // 文件已不存在或不可删，忽略
  }
}

export { STORAGE_DIR, UPLOAD_DIR };
