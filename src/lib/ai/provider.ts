/**
 * Provider Adapter：屏蔽不同模型供应商的差异。
 *
 * 默认 mock（确定性输出、零费用）；external 走 OpenAI 兼容协议，
 * 只有在设置页显式开启且环境变量提供密钥时才会被选中。
 */

import { estimateTokens } from './meter';
import { buildMockPayload } from './mock';
import { redactText } from './privacy';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './types';

export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class MockProvider implements AiProvider {
  readonly mode = 'mock' as const;
  readonly provider = 'mock';
  readonly model: string;

  constructor(model = 'mock-deterministic') {
    this.model = model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const started = Date.now();
    const payload = buildMockPayload(request.kind, request.meta);
    const rawText = JSON.stringify(payload);
    return {
      ok: true,
      rawText,
      json: payload,
      inputTokens: estimateTokens(`${request.system}\n${request.user}`),
      outputTokens: estimateTokens(rawText),
      latencyMs: Date.now() - started,
    };
  }
}

export interface ExternalProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAICompatibleProvider implements AiProvider {
  readonly mode = 'external' as const;
  readonly provider = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: ExternalProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const promptText = `${request.system}\n${request.user}`;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const body = redactText((await response.text()).slice(0, 200));
        return {
          ok: false,
          code: 'PROVIDER_ERROR',
          message: `Provider 返回 ${response.status}：${body}`,
          latencyMs,
          inputTokens: estimateTokens(promptText),
          outputTokens: 0,
        };
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      const inputTokens = body.usage?.prompt_tokens ?? estimateTokens(promptText);
      const outputTokens =
        body.usage?.completion_tokens ?? estimateTokens(content);

      const json = extractJsonObject(content);
      if (json === null) {
        return {
          ok: false,
          code: 'INVALID_OUTPUT',
          message: '模型返回内容不是合法 JSON 对象',
          latencyMs: Date.now() - started,
          inputTokens,
          outputTokens,
          rawText: content.slice(0, 2000),
        };
      }
      return {
        ok: true,
        rawText: content,
        json,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        message: aborted
          ? `请求超过 ${request.timeoutMs}ms 被中止`
          : `网络请求失败：${redactText(String(error)).slice(0, 200)}`,
        latencyMs,
        inputTokens: estimateTokens(promptText),
        outputTokens: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}