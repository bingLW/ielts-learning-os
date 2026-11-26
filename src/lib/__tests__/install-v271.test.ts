import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/install-v271.mts');
const tsx = resolve('node_modules/.bin/tsx');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('v2.7.1 全新安装', () => {
  it('空库建立 schema、只写定义数据并登记完整迁移账本', () => {
    const root = mkdtempSync(join(tmpdir(), 'ielts-install-v271-'));
    roots.push(root);
    const database = join(root, 'new.db');
    const output = execFileSync(tsx, [script, '--db', database], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as {
      ok: boolean;
      migrations: string[];
      learningRows: Record<string, number>;
      integrity: string;
      foreignKeyViolations: number;
    };
    expect(result.ok).toBe(true);
    expect(result.migrations).toEqual(['v2.2', 'v2.3', 'v2.4', 'v2.4.1', 'v2.4.2', 'v2.5', 'v2.6', 'v2.7', 'v2.7.1']);
    expect(Object.values(result.learningRows).every((count) => count === 0)).toBe(true);
    expect(result.integrity).toBe('ok');
    expect(result.foreignKeyViolations).toBe(0);
  }, 120_000);

  it('拒绝覆盖已有数据库和真实 dev.db', () => {
    const root = mkdtempSync(join(tmpdir(), 'ielts-install-guard-'));
    roots.push(root);
    const database = join(root, 'existing.db');
    writeFileSync(database, 'keep-existing-data');
    expect(() => execFileSync(tsx, [script, '--db', database], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/目标数据库非空/);
    expect(() => execFileSync(tsx, [script, '--db', resolve('prisma/dev.db')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/首次安装不得覆盖真实/);
  });
});
