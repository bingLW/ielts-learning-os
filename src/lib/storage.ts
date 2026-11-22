/**
 * v2.5 本地文件存储：音频上传与录音落盘。
 *
 * 原则（架构不变量）：音频二进制**绝不写 SQLite**，只落 `storage/uploads/`，
 * DB 只存相对路径 + sha256 + 大小 + MIME。所有写盘走 `node:fs`，路径经校验，
 * 防目录穿越。
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// ───────────────────── v2.6 学习材料（只追加，不改上面的既有函数） ─────────────────────

/** 材料文件允许的扩展名（小写、不带点）。 */
export const MATERIAL_ALLOWED_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'pdf',
  'docx',
] as const;

/** 材料文件根目录：storage/uploads/materials。 */
export function materialsDir(): string {
  return path.join(uploadsDir(), 'materials');
}

/** 确保材料目录存在，返回绝对路径。 */
export function ensureMaterialsDir(): string {
  const dir = materialsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** materialId 只允许 ASCII 字母数字（cuid/本地 hex id 都满足），用于阻断路径穿越。 */
function assertSafeMaterialId(materialId: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(materialId)) {
    throw new Error('非法材料 ID');
  }
  return materialId;
}

/** 统一扩展名形态：去点、小写、只留字母数字。 */
export function normalizeMaterialExtension(extension: string): string {
  return extension
    .replace(/^\./, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
}

/** 从文件名取扩展名（无扩展名返回空串；非落盘安全边界，仅用于选择解析器）。 */
export function extensionFromFileName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/'));
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return normalizeMaterialExtension(base.slice(dot + 1));
}

/** 扩展名是否在材料白名单内。 */
export function isAllowedMaterialExtension(extension: string): boolean {
  const normalized = normalizeMaterialExtension(extension);
  return (MATERIAL_ALLOWED_EXTENSIONS as readonly string[]).includes(normalized);
}

export interface StoredMaterialFile {
  /** 相对 storage/uploads 的路径：materials/{materialId}/original.{ext}（绝不进前端 DTO）。 */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * 落盘材料原文：`storage/uploads/materials/{materialId}/original.{ext}`。
 *
 * 三条硬约束（架构 §6.6）：
 * 1. `flag:'wx'` —— 绝不覆盖已有文件（同名说明逻辑上重跑，宁可失败）；
 * 2. 写后 `chmod 0444` —— 原文是审计基线，任何后续流程都不得改写；
 * 3. 客户端永不提交路径，路径完全由 materialId + 服务端扩展名拼出。
 */
export function writeOriginalMaterialFile(
  buffer: Buffer,
  materialId: string,
  extension: string,
): StoredMaterialFile {
  const safeId = assertSafeMaterialId(materialId);
  const ext = normalizeMaterialExtension(extension) || 'bin';
  const dir = path.join(ensureMaterialsDir(), safeId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const absolutePath = path.join(dir, `original.${ext}`);
  writeFileSync(absolutePath, buffer, { flag: 'wx' });
  try {
    chmodSync(absolutePath, 0o444);
  } catch {
    // 某些文件系统（容器挂载）不支持改权限：不影响正确性，只是少一层保护
  }
  return {
    relativePath: path.posix.join('materials', safeId, `original.${ext}`),
    absolutePath,
    sizeBytes: buffer.byteLength,
    sha256: sha256Hex(buffer),
  };
}

/** 删除某材料的整个目录（含派生文件）；目录不存在则静默跳过。 */
export function deleteMaterialDir(materialId: string): void {
  const safeId = assertSafeMaterialId(materialId);
  const dir = path.join(materialsDir(), safeId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 目录已不存在或不可删：由调用方决定是否告警
  }
}

export { STORAGE_DIR, UPLOAD_DIR };
