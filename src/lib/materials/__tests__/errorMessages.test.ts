import { describe, expect, it } from 'vitest';

import { PATH_REDACTED, redactMaterialLog, redactMaterialPath } from '@/lib/materials/errorMessages';

describe('redactMaterialPath（G-04：日志/错误不含绝对路径）', () => {
  it('macOS 绝对路径被替换为占位符', () => {
    expect(redactMaterialPath('打开失败 /Users/bing/ielts-learning-os/prisma/dev.db 请重试'))
      .toBe(`打开失败 ${PATH_REDACTED} 请重试`);
  });

  it('Prisma 的 file: 前缀路径被替换', () => {
    expect(redactMaterialPath('unable to open file:/private/var/folders/xx/dev.db'))
      .toContain(PATH_REDACTED);
    expect(redactMaterialPath('unable to open file:/private/var/folders/xx/dev.db'))
      .not.toContain('/private/');
  });

  it('/tmp /opt /home /usr /etc /Library 全部命中', () => {
    for (const prefix of ['/tmp/a', '/opt/a', '/home/b/a', '/usr/local/a', '/etc/hosts', '/Library/x']) {
      expect(redactMaterialPath(`读到 ${prefix} 时失败`)).not.toContain(prefix);
      expect(redactMaterialPath(`读到 ${prefix} 时失败`)).toContain(PATH_REDACTED);
    }
  });

  it('Windows 盘符绝对路径被替换', () => {
    expect(redactMaterialPath('打开 C:\\Users\\bing\\dev.db 失败'))
      .not.toContain('C:\\Users');
    expect(redactMaterialPath('打开 C:\\Users\\bing\\dev.db 失败')).toContain(PATH_REDACTED);
  });

  it('家目录 ~ 缩写被替换', () => {
    expect(redactMaterialPath('读到 ~/ielts-learning-os/prisma/dev.db'))
      .not.toContain('~/');
    expect(redactMaterialPath('读到 ~/ielts-learning-os/prisma/dev.db')).toContain(PATH_REDACTED);
  });

  it('不含路径的普通文本逐字不变', () => {
    const text = 'AI 分析失败：已达单材料调用次数上限（60 次）';
    expect(redactMaterialPath(text)).toBe(text);
  });

  it('空串原样返回', () => {
    expect(redactMaterialPath('')).toBe('');
  });
});

describe('redactMaterialLog（脱敏 + 长度封顶）', () => {
  it('超长文本截断并标注被截断的字符数', () => {
    const long = 'x'.repeat(500);
    const out = redactMaterialLog(long, 200);
    expect(out.length).toBeLessThanOrEqual(220);
    expect(out).toContain('截断 300 字符');
  });

  it('合并连续空白', () => {
    expect(redactMaterialLog('a\n\n  b   c')).toBe('a b c');
  });

  it('纯路径文本脱敏后为空，返回空串', () => {
    expect(redactMaterialLog('/Users/bing/dev.db')).toBe(PATH_REDACTED);
  });
});
