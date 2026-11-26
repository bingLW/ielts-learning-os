import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('P0-6 DB + uploads backup/restore drill', () => {
  it('在 /tmp 全 schema 真库上完成备份、恢复、安全拒绝与显式回滚', async () => {
    const { stdout: output } = await execFileAsync(process.execPath, [resolve('scripts/backup-restore-drill.mjs')], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(output).toContain('real prisma/dev.db is never a backup source or restore target');
    expect(output).toContain('INTEGRITY source=ok restored=ok FOREIGN_KEYS source=0 restored=0');
    expect(output).toContain('negative_cases=17');
    expect(output).toContain('ROLLBACK explicit overwrite safety restore=ok');
    expect(output).toMatch(/PASS backup\+restore drill; .*integrity=ok; foreign_keys=0; restored_rows=16/);
    expect(output).toContain('CLEANUP /tmp restore and drill directories removed');
  }, 180_000);
});
