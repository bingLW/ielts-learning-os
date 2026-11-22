/**
 * Provider 凭据的加密存储与解析。
 *
 * - 页面填写的 API Key 以 AES-256-GCM 加密后存入本机 SQLite（`AIProviderCredential`）；
 * - 加密密钥优先取环境变量 `AI_CREDENTIALS_SECRET`，否则落在 `.local/ai-credentials.key`
 *   （首次使用时生成，权限 0600，已加入 .gitignore）；
 * - 解析优先级：数据库 > 环境变量（兼容既有部署）> 未配置（回落 Mock）。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const PAYLOAD_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SECRET_ENV = 'AI_CREDENTIALS_SECRET';
const KEY_FILE_ENV = 'AI_CREDENTIALS_KEY_FILE';

export type CredentialSource = 'database' | 'environment' | 'none';

export interface CredentialRow {
  baseUrl: string;
  modelName: string;
  apiKeyCipher: string | null;
  apiKeyLast4: string | null;
}

export interface EnvProviderConfig {
  apiKey: string | undefined;
  baseUrl: string;
  modelOverride: string | undefined;
}

export interface ProviderCredentials {
  apiKey: string | undefined;
  baseUrl: string;
  modelOverride: string | undefined;
  source: CredentialSource;
  decryptionFailed: boolean;
}

let cachedKey: Buffer | null = null;

export function credentialKeyFilePath(): string {
  return process.env[KEY_FILE_ENV] ?? path.join(process.cwd(), '.local', 'ai-credentials.key');
}

/** 读取（必要时生成）本机加密密钥。 */
export function loadCredentialKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env[SECRET_ENV]?.trim();
  if (secret) {
    cachedKey = scryptSync(secret, 'ielts-learning-os:provider-credential', KEY_BYTES);
    return cachedKey;
  }

  const file = credentialKeyFilePath();
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(`凭据密钥文件格式非法（应为 64 位十六进制）：${file}`);
    }
    cachedKey = key;
    return cachedKey;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = randomBytes(KEY_BYTES);
  try {
    writeFileSync(file, fresh.toString('hex'), { flag: 'wx', mode: 0o600 });
    cachedKey = fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  }
  return cachedKey;
}

function keyOrLoad(key?: Buffer): Buffer {
  return key ?? loadCredentialKey();
}

export function encryptSecret(plain: string, key?: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyOrLoad(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(payload: string, key?: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error('凭据密文格式不受支持');
  }
  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = createDecipheriv(
    ALGORITHM,
    keyOrLoad(key),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function tryDecryptSecret(payload: string | null | undefined, key?: Buffer): string | null {
  if (!payload) return null;
  try {
    return decryptSecret(payload, key);
  } catch {
    return null;
  }
}

export function maskApiKey(last4: string | null | undefined): string {
  return last4 ? `••••••••${last4}` : '未配置';
}

export function resolveProviderCredentials(
  row: CredentialRow | null | undefined,
  env: EnvProviderConfig,
  key?: Buffer,
): ProviderCredentials {
  const dbApiKey = tryDecryptSecret(row?.apiKeyCipher, key);
  const decryptionFailed = Boolean(row?.apiKeyCipher) && dbApiKey === null;

  const dbBaseUrl = row?.baseUrl?.trim();
  const baseUrl =
    dbBaseUrl && /^https?:\/\//.test(dbBaseUrl) ? dbBaseUrl : env.baseUrl;
  const modelOverride = row?.modelName?.trim() || env.modelOverride;
  const apiKey = dbApiKey ?? env.apiKey;

  const source: CredentialSource = dbApiKey
    ? 'database'
    : env.apiKey
      ? 'environment'
      : 'none';

  return { apiKey, baseUrl, modelOverride, source, decryptionFailed };
}