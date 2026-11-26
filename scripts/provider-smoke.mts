import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ensurePromptRegistry } from '../src/lib/ai/registry';
import { runAiCompletion } from '../src/lib/ai/orchestrator';

const LIVE_DB = resolve('prisma/dev.db');

function output(status: 'NOT_RUN' | 'REAL_PROVIDER' | 'FAIL', details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ status, ...details }));
}

async function main() {
  if (process.env.AI_SMOKE_OPT_IN !== '1') {
    output('NOT_RUN', { reason: '未显式设置 AI_SMOKE_OPT_IN=1' });
    return;
  }
  if (process.env.AI_SMOKE_CONSENT !== '1') {
    output('NOT_RUN', { reason: '未显式确认 AI_SMOKE_CONSENT=1，不进行第三方外发' });
    return;
  }
  const apiKey = process.env.AI_PROVIDER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length < 8) {
    output('NOT_RUN', { reason: '缺少 Provider API Key' });
    return;
  }
  const baseUrl = process.env.AI_PROVIDER_BASE_URL;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl.trim())) {
    output('NOT_RUN', { reason: '缺少合法的 AI_PROVIDER_BASE_URL' });
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('file:/tmp/')) {
    output('FAIL', { reason: '冒烟测试只允许 file:/tmp/ 下的显式隔离数据库' });
    process.exitCode = 1;
    return;
  }
  const databasePath = resolve(databaseUrl.slice('file:'.length));
  if (databasePath === LIVE_DB) {
    output('FAIL', { reason: '安全阻断：不得对真实 prisma/dev.db 执行 Provider 冒烟测试' });
    process.exitCode = 1;
    return;
  }
  const dailyBudgetUsd = Number(process.env.AI_SMOKE_DAILY_BUDGET_USD ?? '1');
  const monthlyBudgetUsd = Number(process.env.AI_SMOKE_MONTHLY_BUDGET_USD ?? '10');
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0
    || !Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0) {
    output('NOT_RUN', { reason: '日/月预算必须为正数' });
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await ensurePromptRegistry(prisma);
    await prisma.userProfile.upsert({
      where: { id: 1 },
      create: { id: 1, timezone: process.env.AI_SMOKE_TIMEZONE ?? 'Asia/Singapore' },
      update: { timezone: process.env.AI_SMOKE_TIMEZONE ?? 'Asia/Singapore' },
    });
    await prisma.learnerProfile.upsert({
      where: { id: 'default' },
      create: { id: 'default', externalAiConsent: true },
      update: { externalAiConsent: true },
    });
    await prisma.aIEngineSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', externalAiEnabled: true, dailyBudgetUsd, monthlyBudgetUsd },
      update: { externalAiEnabled: true, dailyBudgetUsd, monthlyBudgetUsd },
    });
    await prisma.aIModelConfig.upsert({
      where: { id: 'provider-smoke-model' },
      create: {
        id: 'provider-smoke-model', provider: 'openai-compatible',
        model: process.env.AI_PROVIDER_MODEL ?? 'smoke-model', label: 'Provider 冒烟测试',
        active: true, isDefault: true,
        inputPricePerMtok: Number(process.env.AI_SMOKE_INPUT_PRICE_PER_MTOK ?? '0'),
        outputPricePerMtok: Number(process.env.AI_SMOKE_OUTPUT_PRICE_PER_MTOK ?? '0'),
      },
      update: {
        provider: 'openai-compatible', model: process.env.AI_PROVIDER_MODEL ?? 'smoke-model',
        active: true, isDefault: true,
        inputPricePerMtok: Number(process.env.AI_SMOKE_INPUT_PRICE_PER_MTOK ?? '0'),
        outputPricePerMtok: Number(process.env.AI_SMOKE_OUTPUT_PRICE_PER_MTOK ?? '0'),
      },
    });
    await prisma.aIModelConfig.updateMany({
      where: { id: { not: 'provider-smoke-model' } },
      data: { isDefault: false },
    });

    const result = await runAiCompletion({
      prisma,
      promptKind: 'hint',
      maxOutputTokens: 200,
      timeoutMs: 30_000,
      meta: {
        mode: 'TUTOR', skill: 'WRITING', objective: '返回一条通用英语写作提示',
        targetLevel: 'B1', practiceQuestion: 'Write one sentence about a book you enjoyed.',
      },
      logMetadata: { purpose: 'provider-smoke', synthetic: true },
    });
    if (!result.ok || result.status !== 'OK') {
      output('FAIL', { code: result.ok ? result.status : result.code, logId: result.logId ?? null });
      process.exitCode = 1;
      return;
    }
    output('REAL_PROVIDER', {
      provider: result.provider, model: result.model, logId: result.logId,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd, synthetic: true,
    });
  } finally {
    await prisma.$disconnect();
  }
}

await main();
