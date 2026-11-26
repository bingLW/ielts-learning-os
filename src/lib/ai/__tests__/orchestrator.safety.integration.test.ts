import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@/lib/__tests__/helpers/testDb';
import { estimateMaxCallCostUsd } from '../meter';
import { redactText } from '../privacy';
import { buildMockPayload } from '../mock';
import { renderPrompt } from '../prompts';
import type { AiPromptMeta } from '../types';

process.env.AI_CREDENTIALS_SECRET ??= 'ielts-v271-integration-test-secret';
process.env.AI_PROVIDER_API_KEY = 'sk-test-1234567890';
process.env.AI_PROVIDER_BASE_URL = 'https://provider.example.test/v1';

const { prisma, cleanup } = await createTestDb();
const { runAiCompletion } = await import('../orchestrator');
const { ensurePromptRegistry } = await import('../registry');
const { OpenAICompatibleProvider } = await import('../provider');

const META: AiPromptMeta = {
  mode: 'TUTOR',
  skill: 'WRITING',
  objective: '用 5 句话描述一次难忘的旅行',
  targetLevel: 'B1',
  baseline: 'Last year I went to the beach with my family.',
};

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(buildMockPayload('hint', META)) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function configureExternal(consent = true): Promise<void> {
  await prisma.aIEngineSetting.update({
    where: { id: 'default' },
    data: { externalAiEnabled: true, dailyBudgetUsd: 1, monthlyBudgetUsd: 20 },
  });
  await prisma.learnerProfile.upsert({
    where: { id: 'default' },
    create: { id: 'default', externalAiConsent: consent },
    update: { externalAiConsent: consent },
  });
}

function completion(meta: AiPromptMeta = META) {
  return runAiCompletion({ prisma, promptKind: 'hint', meta, maxOutputTokens: 100 });
}

async function reservedUsd(): Promise<number> {
  return (await prisma.aIEngineSetting.findUniqueOrThrow({ where: { id: 'default' } })).budgetReservedUsd;
}

beforeAll(async () => {
  await ensurePromptRegistry(prisma);
  await prisma.userProfile.create({ data: { id: 1, timezone: 'America/Phoenix' } });
  await prisma.aIEngineSetting.create({ data: { id: 'default' } });
  await prisma.aIModelConfig.create({
    data: {
      id: 'external-test-model',
      provider: 'openai-compatible',
      model: 'test-model',
      label: '测试外部模型',
      active: true,
      isDefault: true,
      inputPricePerMtok: 1,
      outputPricePerMtok: 1,
    },
  });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await prisma.aICallLog.deleteMany();
  await prisma.aIEngineSetting.update({
    where: { id: 'default' },
    data: {
      externalAiEnabled: false,
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 20,
      budgetReservedUsd: 0,
    },
  });
  await prisma.aIModelConfig.update({
    where: { id: 'external-test-model' },
    data: { inputPricePerMtok: 1, outputPricePerMtok: 1 },
  });
  await prisma.learnerProfile.upsert({
    where: { id: 'default' },
    create: { id: 'default', externalAiConsent: false },
    update: { externalAiConsent: false },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

describe('v2.7.1 外发同意与预算安全', () => {
  it('mock 无同意且零预算仍可使用', async () => {
    await prisma.aIEngineSetting.update({
      where: { id: 'default' },
      data: { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await completion();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('MOCK');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('external 无同意写 BLOCKED 并返回 PRECONDITION，不调用 Provider', async () => {
    await configureExternal(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await completion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PRECONDITION');
    expect(result.logId).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    const log = await prisma.aICallLog.findUniqueOrThrow({ where: { id: result.logId! } });
    expect(log.status).toBe('BLOCKED');
    expect(log.errorCode).toBe('EXTERNAL_AI_CONSENT_REQUIRED');
    expect(await reservedUsd()).toBe(0);
  });

  it('external 零预算首次调用即拒绝，mock 不受此门槛影响', async () => {
    await configureExternal(true);
    await prisma.aIEngineSetting.update({
      where: { id: 'default' },
      data: { dailyBudgetUsd: 0 },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await completion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BUDGET_EXCEEDED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.aICallLog.count({ where: { status: 'BLOCKED' } })).toBe(1);
  });

  it('external 模型价格为零时仍调用 Provider，但预算预占与结算始终为零', async () => {
    await configureExternal(true);
    await prisma.aIModelConfig.update({
      where: { id: 'external-test-model' },
      data: { inputPricePerMtok: 0, outputPricePerMtok: 0 },
    });
    const fetchMock = vi.fn(async () => successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await completion();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('OK');
      expect(result.estimatedCostUsd).toBe(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await reservedUsd()).toBe(0);
    const log = await prisma.aICallLog.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(log).toMatchObject({ status: 'OK', estimatedCostUsd: 0 });
  });

  it('外发前统一脱敏路径、邮箱、key 与文件 URL，日志不含敏感原文', async () => {
    await configureExternal(true);
    const sensitive = '联系 a@b.com，key sk-abcdefgh12345678，/Users/bing/secret.docx，https://cdn.example/a.mp3';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await completion({ ...META, objective: sensitive });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const sent = body.messages.map((message) => message.content).join('\n');
    expect(sent).toContain('[email]');
    expect(sent).toContain('[key]');
    expect(sent).toContain('[path]');
    expect(sent).toContain('[file-url]');
    expect(sent).not.toContain('a@b.com');
    expect(sent).not.toContain('/Users/bing');
    expect(sent).not.toContain('sk-abcdefgh12345678');
    if (result.ok) {
      const log = await prisma.aICallLog.findUniqueOrThrow({ where: { id: result.logId } });
      expect(log.redactedMetadataJson).not.toContain('a@b.com');
      expect(log.redactedMetadataJson).not.toContain('/Users/bing');
    }
  });

  it('Provider 失败时原子释放预占并保留一条 append-only 日志', async () => {
    await configureExternal(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider unavailable', { status: 503 })));

    const result = await completion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(await reservedUsd()).toBe(0);
    expect(await prisma.aICallLog.count()).toBe(1);
  });

  it('Provider 抛异常时释放预占，错误摘要脱敏', async () => {
    await configureExternal(true);
    vi.spyOn(OpenAICompatibleProvider.prototype, 'complete').mockRejectedValue(
      new Error('unexpected /Users/bing/private/trace'),
    );

    const result = await completion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVIDER_ERROR');
    expect(await reservedUsd()).toBe(0);
    const log = await prisma.aICallLog.findUniqueOrThrow({ where: { id: result.logId! } });
    expect(log.status).toBe('ERROR');
    expect(log.redactedMetadataJson).not.toContain('/Users/bing/private');
  });

  it('事务 CAS 预占、设置更新不覆盖预留、并发只允许预算内调用', async () => {
    await configureExternal(true);
    const rendered = renderPrompt('hint', META);
    const system = redactText(rendered.system);
    const user = redactText(rendered.user);
    const upperBound = estimateMaxCallCostUsd(system, user, 100, {
      inputPricePerMtok: 1,
      outputPricePerMtok: 1,
    });
    // 上限留出一个最小计价单位，确保一次预占可容纳，第二次则被剩余额度拒绝。
    const availableBudget = upperBound + 0.000001;
    await prisma.aIEngineSetting.update({
      where: { id: 'default' },
      data: { dailyBudgetUsd: availableBudget, monthlyBudgetUsd: availableBudget },
    });

    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn(async () => {
      started();
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = completion();
    await providerStarted;
    expect(await reservedUsd()).toBeCloseTo(upperBound, 9);

    // 设置变更只改 warnPercent，不得清零进行中的预占。
    await prisma.aIEngineSetting.update({
      where: { id: 'default' },
      data: { warnPercent: 90 },
    });
    expect(await reservedUsd()).toBeCloseTo(upperBound, 9);

    const second = await completion();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('BUDGET_EXCEEDED');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(successResponse());
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(await reservedUsd()).toBe(0);
    expect(await prisma.aICallLog.count({ where: { status: { in: ['OK', 'MOCK'] } } })).toBe(1);
    expect(await prisma.aICallLog.count({ where: { status: 'BLOCKED' } })).toBe(1);
  }, 20_000);
});
