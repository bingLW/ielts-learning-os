import { describe, expect, it } from 'vitest';
import {
  extensionFromMime,
  isAllowedExtension,
  sha256Hex,
  uniqueFileName,
} from '@/lib/storage';

describe('sha256Hex', () => {
  it('计算确定性 sha256', () => {
    const hex = sha256Hex(Buffer.from('hello'));
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('uniqueFileName', () => {
  it('生成带日期前缀与扩展名的唯一名', () => {
    const name = uniqueFileName('mp3');
    expect(name).toMatch(/^\d{8}-[0-9a-f]{16}\.mp3$/);
  });
  it('清洗非法扩展名字符', () => {
    const name = uniqueFileName('MP3!');
    expect(name.endsWith('.mp3')).toBe(true);
  });
});

describe('isAllowedExtension', () => {
  it('允许常见音频扩展名', () => {
    for (const ext of ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac']) {
      expect(isAllowedExtension(ext)).toBe(true);
      expect(isAllowedExtension(`.${ext}`)).toBe(true);
    }
  });
  it('拒绝非音频扩展名', () => {
    expect(isAllowedExtension('exe')).toBe(false);
    expect(isAllowedExtension('txt')).toBe(false);
  });
});

describe('extensionFromMime', () => {
  it('映射 MIME 到扩展名', () => {
    expect(extensionFromMime('audio/mpeg')).toBe('mp3');
    expect(extensionFromMime('audio/mp4')).toBe('m4a');
    expect(extensionFromMime('audio/wav')).toBe('wav');
  });
  it('未知 MIME 回退 bin', () => {
    expect(extensionFromMime('application/octet-stream')).toBe('bin');
    expect(extensionFromMime(null)).toBe('bin');
  });
});
