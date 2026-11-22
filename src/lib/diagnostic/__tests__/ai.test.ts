import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { evaluateOpenResponse } from '../ai';

const base = {
  prisma: {} as unknown as PrismaClient,
  kind: 'diag_writing' as const,
  itemPrompt: 'Write a short paragraph about your weekend.',
  rubricSummary: '任务完成度：要点齐全；语言准确性：错误不影响理解',
  learnerAnswer: 'I went to the park with my family last Saturday.',
};

describe('诊断开放任务的外发同意', () => {
  it('未同意或未声明同意时不调用外部模型', async () => {
    for (const externalAiConsent of [undefined, false]) {
      const result = await evaluateOpenResponse({ ...base, externalAiConsent });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('AI_UNAVAILABLE');
        expect(result.message).toContain('未同意');
      }
    }
  });
});