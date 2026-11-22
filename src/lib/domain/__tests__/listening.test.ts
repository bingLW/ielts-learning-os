import { describe, expect, it } from 'vitest';
import {
  hasNoListeningOutput,
  isTechnicalListeningError,
  isValidListeningErrorType,
  needsSpeakingFollowUp,
  speakingConfidenceFromDimensions,
  suggestListeningErrors,
} from '@/lib/domain/listening';

describe('suggestListeningErrors（词级对照建议）', () => {
  it('参考转写有、首听漏掉的词 → MISSED_DETAIL', () => {
    const result = suggestListeningErrors('I like coffee', 'I like coffee and tea');
    expect(result).toContain('MISSED_DETAIL');
  });

  it('首听覆盖参考全部词 → 无建议', () => {
    const result = suggestListeningErrors('the cat sat on the mat', 'the cat sat on the mat');
    expect(result).toEqual([]);
  });

  it('空参考 → 空建议', () => {
    expect(suggestListeningErrors('anything', '')).toEqual([]);
  });

  it('大小写与标点不影响对照', () => {
    const result = suggestListeningErrors('HELLO, world!', 'hello world again');
    expect(result).toContain('MISSED_DETAIL');
  });
});

describe('isTechnicalListeningError', () => {
  it('AUDIO_QUALITY 是技术问题', () => {
    expect(isTechnicalListeningError('AUDIO_QUALITY')).toBe(true);
  });
  it('MISSED_DETAIL 是能力问题', () => {
    expect(isTechnicalListeningError('MISSED_DETAIL')).toBe(false);
  });
});

describe('isValidListeningErrorType', () => {
  it('合法类型返回 true', () => {
    expect(isValidListeningErrorType('UNKNOWN_VOCABULARY')).toBe(true);
  });
  it('非法类型返回 false', () => {
    expect(isValidListeningErrorType('NOT_A_TYPE')).toBe(false);
  });
});

describe('hasNoListeningOutput', () => {
  it('首听与辅助后都空 → 无产出', () => {
    expect(hasNoListeningOutput(null, null)).toBe(true);
    expect(hasNoListeningOutput('  ', '')).toBe(true);
  });
  it('任一非空 → 有产出', () => {
    expect(hasNoListeningOutput('heard something', null)).toBe(false);
    expect(hasNoListeningOutput(null, 'assisted result')).toBe(false);
  });
});

describe('speakingConfidenceFromDimensions', () => {
  it('可理解度技术不可靠 → LOW', () => {
    const result = speakingConfidenceFromDimensions([
      { key: 'intelligibility', reliable: false },
      { key: 'fluency', reliable: true },
    ]);
    expect(result).toBe('LOW');
  });
  it('发音技术不可靠 → LOW', () => {
    const result = speakingConfidenceFromDimensions([
      { key: 'pronunciation', reliable: false },
    ]);
    expect(result).toBe('LOW');
  });
  it('全部可靠 → HIGH', () => {
    const result = speakingConfidenceFromDimensions([
      { key: 'fluency', reliable: true },
      { key: 'vocabulary', reliable: true },
    ]);
    expect(result).toBe('HIGH');
  });
  it('部分非技术维度不可靠 → MEDIUM', () => {
    const result = speakingConfidenceFromDimensions([
      { key: 'fluency', reliable: true },
      { key: 'coherence', reliable: false },
    ]);
    expect(result).toBe('MEDIUM');
  });
});

describe('needsSpeakingFollowUp', () => {
  it('LOW 需要补测', () => {
    expect(needsSpeakingFollowUp('LOW')).toBe(true);
  });
  it('MEDIUM/HIGH 不需要', () => {
    expect(needsSpeakingFollowUp('MEDIUM')).toBe(false);
    expect(needsSpeakingFollowUp('HIGH')).toBe(false);
  });
});
