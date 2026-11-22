import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMockPayload } from '../mock';
import { extractJsonObject, MockProvider, OpenAICompatibleProvider } from '../provider';
import type { AiCompletionRequest, AiPromptMeta } from '../types';

const meta: AiPromptMeta = {
  mode: 'TUTOR',
  skill: 'WRITING',
  objective: '写一段自我介绍',
  targetLevel: 'A2',
  baseline: 'Hello, I am...',
};

function request(overrides: Partial<AiCompletionRequest> = {}): AiCompletionRequest {
  return {
    kind: 'task',
    system: 'system',
    user: 'user',
    temperature: 0.2,
    maxOutputTokens: 800,
    timeoutMs: 1000,
    meta,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JSON 提取', () => {
  it('支持纯 JSON、代码块包裹与前后带文字', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('结果如下：{"a":{"b":2}} 完毕')).toEqual({ a: { b: 2 } });
  });

  it('非法输入返回 null，不抛异常', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('[1,2,3]')).toBeNull();
    expect(extractJsonObject('{broken')).toBeNull();
  });
});

describe('MockProvider', () => {
  it('相同输入输出完全确定，且通过结构化协议', async () => {
    const provider = new MockProvider();
    const first = await provider.complete(request());
    const second = await provider.complete(request());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.rawText).toBe(second.rawText);
      expect(first.json).toEqual(buildMockPayload('task', meta));
      expect(first.inputTokens).toBeGreaterThan(0);
      expect(first.outputTokens).toBeGreaterThan(0);
    }
    expect(provider.mode).toBe('mock');
  });
});

describe('OpenAICompatibleProvider', () => {
  const options = {
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test-1234567890',
    model: 'model-x',
  };

  it('成功时使用返回的 usage 并解析 JSON', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider(options);
    const result = await provider.complete(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.json).toEqual({ ok: true });
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(20);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('非 2xx 返回 PROVIDER_ERROR，且错误体经过脱敏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key sk-abcdefgh12345678', { status: 401 })),
    );
    const provider = new OpenAICompatibleProvider(options);
    const result = await provider.complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROVIDER_ERROR');
      expect(result.message).toContain('401');
      expect(result.message).toContain('[key]');
      expect(result.message).not.toContain('abcdefgh12345678');
    }
  });

  it('内容不是 JSON 对象时返回 INVALID_OUTPUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'plain text' } }] }), {
          status: 200,
        }),
      ),
    );
    const provider = new OpenAICompatibleProvider(options);
    const result = await provider.complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_OUTPUT');
  });

  it('网络异常与超时分别归类', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    let result = await new OpenAICompatibleProvider(options).complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NETWORK');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }),
    );
    result = await new OpenAICompatibleProvider(options).complete(request({ timeoutMs: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TIMEOUT');
  });
});