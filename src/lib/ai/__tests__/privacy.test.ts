import { describe, expect, it } from 'vitest';
import { excerpt, redactMetadata, redactText } from '../privacy';

describe('文本脱敏', () => {
  it('替换邮箱、Bearer、API Key、长数字与文件链接', () => {
    const input = [
      '联系 me@example.com',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'key sk-abcdefgh12345678',
      '订单号 123456789012',
      '录音 https://cdn.example.com/a.mp3',
    ].join('\n');
    const output = redactText(input);
    expect(output).toContain('[email]');
    expect(output).toContain('Bearer [key]');
    expect(output).toContain('[key]');
    expect(output).toContain('[number]');
    expect(output).toContain('[file-url]');
    expect(output).not.toContain('me@example.com');
    expect(output).not.toContain('abcdefgh12345678');
  });

  it('普通文本保持原样', () => {
    expect(redactText('今天练习 Task 2，用时 40 分钟。')).toBe('今天练习 Task 2，用时 40 分钟。');
  });
});

describe('元数据脱敏', () => {
  it('敏感键整体替换，嵌套字符串正常脱敏', () => {
    const output = redactMetadata({
      apiKey: 'raw-secret-value',
      note: '写给 a@b.com',
      nested: { token: 'abc', list: ['x@y.com'] },
    }) as Record<string, unknown>;
    expect(output.apiKey).toBe('[redacted]');
    expect(output.note).toBe('写给 [email]');
    expect((output.nested as Record<string, unknown>).token).toBe('[redacted]');
    expect(((output.nested as Record<string, unknown>).list as string[])[0]).toBe('[email]');
  });

  it('超深层级与超长字符串被截断', () => {
    const deep = redactMetadata({ a: { b: { c: { d: { e: 'x' } } } } });
    expect(JSON.stringify(deep)).toContain('[depth-limit]');
    const long = redactMetadata('y'.repeat(1000));
    expect(typeof long).toBe('string');
    expect((long as string).length).toBe(400);
  });
});

describe('作答摘要', () => {
  it('取首句并按上限截断', () => {
    expect(excerpt('First sentence. Second one.', 80)).toBe('First sentence');
    expect(excerpt('这是一句中文。后面还有。', 80)).toBe('这是一句中文');
    expect(excerpt('a'.repeat(100), 10)).toBe(`${'a'.repeat(10)}…`);
    expect(excerpt('  只有一句  ', 80)).toBe('只有一句');
  });
});