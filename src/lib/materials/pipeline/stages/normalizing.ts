/**
 * 阶段 3：normalizing —— 分块 + 落 `ParsedDocument`/`ContentChunk` + 汇总计数。
 *
 * 这是「纯 CPU」阶段：解析快照已在 `extracting` 落盘，这里只读 JSON 再分块，
 * 因此重试时可以只重跑本阶段（`retryMaterialJobAction` 的 `fromStage='normalizing'`）。
 *
 * 状态机约束：`normalizing → analyzing`（成功）/ `→ partial`（chunk 数超 800 或解析
 * 本身已降级）/ `→ failed`（有效文本为 0 / 分块失败）。
 *
 * 「停在 review_required」不在这里做：`analyzing` 阶段尚未接入（T09），由
 * `pipeline.ts` 在状态推进到 `analyzing` 后再走合法的 `analyzing → review_required`。
 */

import { createHash } from 'node:crypto';
import { MATERIAL_ERROR_MESSAGES_ZH, MATERIAL_LIMITS } from '@/lib/constants';
import { stringify } from '@/lib/json';
import { chunkParagraphs } from '@/lib/materials/chunk';
import { checkChunkCount } from '@/lib/materials/limits';
import { prisma } from '@/lib/prisma';
import { createParsedDocumentWithChunks } from '@/lib/services/materialChunkRepo';
import { estimateMinutes } from '../parseStage';
import { loadParsedSnapshot } from './extracting';
import {
  stageCancelled,
  stageFailure,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from '../stageContract';

function textChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const normalizingStage: StageHandler = async (ctx: StageContext): Promise<StageOutcome> => {
  const { material } = ctx;

  const asset = await prisma.materialAsset.findFirst({
    where: { materialId: material.id, kind: 'PARSED_JSON' },
    select: { relativePath: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!asset) {
    return stageFailure('normalizing', 'NO_TEXT', '找不到解析快照，请重试（失败会从解析重新开始）');
  }

  const snapshot = loadParsedSnapshot(asset.relativePath);
  if (!snapshot) {
    return stageFailure('normalizing', 'NO_TEXT', '解析快照已损坏，请重试');
  }
  const parsed = snapshot.parsed;

  if (parsed.paragraphs.length === 0) {
    return stageFailure(
      'normalizing',
      'NO_TEXT',
      MATERIAL_ERROR_MESSAGES_ZH.NO_TEXT ?? '没有可用的正文段落',
    );
  }

  if (await ctx.isCancelled()) return stageCancelled(ctx);

  // ── 分块（ADR-03）──────────────────────────────────────────────────
  let chunkResult;
  try {
    chunkResult = chunkParagraphs(parsed.paragraphs);
  } catch {
    return stageFailure('normalizing', 'NO_TEXT', '正文分块失败（文本结构异常），可重试');
  }

  if (chunkResult.chunks.length === 0) {
    return stageFailure('normalizing', 'NO_TEXT', '有效文本为 0，无法生成可分析的内容块');
  }

  const chunkLimit = checkChunkCount(chunkResult.chunks.length);
  const degraded = parsed.status === 'PARTIAL' || chunkResult.truncated || !chunkLimit.ok;

  const warnings = [...parsed.warnings, ...chunkResult.warnings];
  const reasonParts: string[] = [];
  if (parsed.noTextLayerPages.length > 0) {
    reasonParts.push(`第 ${parsed.noTextLayerPages.join('、')} 页没有文本层（扫描页）`);
  }
  if (chunkResult.truncated || !chunkLimit.ok) {
    reasonParts.push(`内容较长，仅处理前 ${MATERIAL_LIMITS.maxChunks} 个分块`);
  }
  const statusReason = degraded
    ? reasonParts.join('；') || warnings.filter((item) => item.trim().length > 0).join('；').slice(0, 500)
      || '部分内容未能解析，已按可用部分继续'
    : null;

  // ── 落库：新 ParsedDocument(version+1) + 新 chunk 集 + isCurrent 切换 ──
  let created;
  try {
    created = await createParsedDocumentWithChunks({
      materialId: material.id,
      parserName: snapshot.parserName,
      parserVersion: snapshot.parserVersion,
      status: parsed.status,
      pageCount: parsed.pageCount,
      paragraphCount: parsed.paragraphCount,
      charCount: parsed.charCount,
      warningsJson: stringify({
        warnings,
        droppedElements: parsed.droppedElements,
        noTextLayerPages: parsed.noTextLayerPages,
        hardSplits: chunkResult.hardSplits,
        truncated: chunkResult.truncated,
      }),
      textChecksum: textChecksum(parsed.text),
      chunks: chunkResult.chunks,
    });
  } catch {
    return stageFailure('normalizing', 'INTERNAL_STORAGE', '分块结果写入数据库失败，可重试');
  }

  if (await ctx.isCancelled()) return stageCancelled(ctx);

  const estimatedMinutes = estimateMinutes(parsed.wordCount);

  return {
    to: degraded ? 'partial' : 'analyzing',
    stage: degraded ? 'normalizing' : 'analyzing',
    progress: { done: created.chunkCount, total: created.chunkCount, unitLabel: '分块' },
    statusReason,
    counts: {
      charCount: parsed.charCount,
      wordCount: parsed.wordCount,
      pageCount: parsed.pageCount,
      chunkCount: created.chunkCount,
      estimatedMinutes,
    },
    partial: degraded
      ? {
          pages: parsed.noTextLayerPages,
          droppedElements: parsed.droppedElements,
          aiCallLimitHit: false,
        }
      : undefined,
    jobStatus: degraded ? 'succeeded' : 'running',
    didWork: true,
  };
};
