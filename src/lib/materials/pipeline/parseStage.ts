/**
 * 解析阶段编排（T07）：选解析器 → 解析 → 分块 → 落库 → 更新材料状态。
 *
 * 状态机口径（与 ADR-05 的阶段推进一致）：
 * - 解析 + 分块成功 → `analyzing`（下一步等 T09 的 AI 分析）；
 * - 有页/段缺失、chunk 截断 → `partial` + 人话 `statusReason`；
 * - 抛错 → `failed` + 固定中文文案（`MATERIAL_ERROR_MESSAGES_ZH`，绝不透传原始 message）。
 *
 * 本阶段**只**负责 extracting + normalizing 两步；tick 引擎、取消、重试在 T08。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MATERIAL_ERROR_MESSAGES_ZH,
  MATERIAL_LIMITS,
  type MaterialFormat,
  type MaterialStatus,
} from '@/lib/constants';
import { stringify } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { fail, ok } from '@/lib/result';
import { resolveUploadPath } from '@/lib/storage';
import type { ActionResult } from '@/lib/types';
import { chunkParagraphs } from '@/lib/materials/chunk';
import { checkChunkCount } from '@/lib/materials/limits';
import { createParsedDocumentWithChunks } from '@/lib/services/materialChunkRepo';
import { docxParser } from '@/lib/materials/parsers/docx';
import { htmlParser } from '@/lib/materials/parsers/html';
import { markdownParser } from '@/lib/materials/parsers/markdown';
import { pdfParser } from '@/lib/materials/parsers/pdf';
import { txtParser } from '@/lib/materials/parsers/txt';
import { MaterialParseError, type MaterialParser, type ParseResult } from '@/lib/materials/parsers/types';

const PARSERS: Record<string, MaterialParser> = {
  TXT: txtParser,
  PASTED_TEXT: txtParser,
  MARKDOWN: markdownParser,
  HTML: htmlParser,
  DOCX: docxParser,
  PDF: pdfParser,
};

export interface ParseStageResult {
  parsedDocumentId: string;
  version: number;
  chunkCount: number;
  status: 'OK' | 'PARTIAL';
  charCount: number;
  wordCount: number;
  pageCount: number | null;
  estimatedMinutes: number | null;
  warnings: string[];
  noTextLayerPages: number[];
}

/** 按材料格式取解析器（`PASTED_TEXT` 复用 TXT 解析器，正文已是纯文本）。 */
export function pickParser(format: string): MaterialParser | null {
  return PARSERS[format] ?? null;
}

/** 预计学习时长：阅读（180 wpm）+ 10 分钟练习，四舍五入到 5 分钟，下限 5。 */
export function estimateMinutes(wordCount: number): number {
  const reading = wordCount / MATERIAL_LIMITS.readingWpm;
  const total = reading + 10;
  return Math.max(5, Math.round(total / 5) * 5);
}

function textChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function markFailed(materialId: string, code: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.learningMaterial.update({
      where: { id: materialId },
      data: { status: 'failed' satisfies MaterialStatus, statusReason: reason },
    });
    await tx.processingJob.updateMany({
      where: { materialId, status: 'running' },
      data: {
        status: 'failed',
        errorCode: code,
        errorMessage: reason,
        finishedAt: new Date(),
      },
    });
  });
}

/**
 * 执行解析 + 分块并落库。
 *
 * @param materialId 目标材料 id（原文必须已是 `MaterialAsset(kind='ORIGINAL_FILE')`）
 */
export async function runParseStage(materialId: string): Promise<ActionResult<ParseStageResult>> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      format: true,
      status: true,
      language: true,
      assets: {
        where: { kind: 'ORIGINAL_FILE' },
        select: { relativePath: true },
        take: 1,
      },
    },
  });
  if (!material) return fail<ParseStageResult>('NOT_FOUND', '材料不存在');

  const asset = material.assets[0];
  if (!asset) {
    await markFailed(materialId, 'INVALID_MAGIC', '材料原文缺失，无法解析');
    return fail<ParseStageResult>('PRECONDITION', '材料原文缺失，无法解析');
  }

  const parser = pickParser(material.format as MaterialFormat);
  if (!parser) {
    const message = MATERIAL_ERROR_MESSAGES_ZH.UNSUPPORTED_FORMAT ?? '暂不支持该文件格式';
    await markFailed(materialId, 'UNSUPPORTED_FORMAT', message);
    return fail<ParseStageResult>('VALIDATION', message);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveUploadPath(asset.relativePath));
  } catch {
    await markFailed(materialId, 'INVALID_MAGIC', '读取原文文件失败，请重新导入');
    return fail<ParseStageResult>('INTERNAL', '读取原文文件失败，请重新导入');
  }

  let parsed: ParseResult;
  try {
    parsed = await parser.parse({ bytes });
  } catch (error) {
    const code = error instanceof MaterialParseError ? error.code : 'INVALID_MAGIC';
    const reason = MATERIAL_ERROR_MESSAGES_ZH[code] ?? '解析失败，可重试或改用更小的文件';
    await markFailed(materialId, code, reason);
    return fail<ParseStageResult>('VALIDATION', reason);
  }

  if (parsed.paragraphs.length === 0) {
    const reason = MATERIAL_ERROR_MESSAGES_ZH.NO_TEXT ?? '没有提取到任何文字';
    await markFailed(materialId, 'NO_TEXT', reason);
    return fail<ParseStageResult>('VALIDATION', reason);
  }

  const chunkResult = chunkParagraphs(parsed.paragraphs);
  const chunkLimit = checkChunkCount(chunkResult.chunks.length);
  const degraded = parsed.status === 'PARTIAL' || chunkResult.truncated || !chunkLimit.ok;

  const warnings = [...parsed.warnings, ...chunkResult.warnings];
  const statusReason = degraded
    ? warnings.filter((item) => item.trim().length > 0).join('；').slice(0, 500) ||
      '部分内容未能解析，已按可用部分继续'
    : null;

  const created = await createParsedDocumentWithChunks({
    materialId,
    parserName: parsed.format,
    parserVersion: parser.parserVersion,
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

  const estimatedMinutes = estimateMinutes(parsed.wordCount);
  const nextStatus: MaterialStatus = degraded ? 'partial' : 'analyzing';

  await prisma.$transaction(async (tx) => {
    await tx.learningMaterial.update({
      where: { id: materialId },
      data: {
        status: nextStatus,
        statusReason,
        charCount: parsed.charCount,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
        chunkCount: created.chunkCount,
        estimatedMinutes,
      },
    });
    await tx.processingJob.updateMany({
      where: { materialId, status: 'running' },
      data: {
        stage: degraded ? 'normalizing' : 'analyzing',
        progressJson: stringify({
          stage: degraded ? 'normalizing' : 'analyzing',
          done: created.chunkCount,
          total: created.chunkCount,
          unitLabel: '分块',
        }),
        lastTickAt: new Date(),
      },
    });
  });

  return ok<ParseStageResult>({
    parsedDocumentId: created.parsedDocumentId,
    version: created.version,
    chunkCount: created.chunkCount,
    status: parsed.status,
    charCount: parsed.charCount,
    wordCount: parsed.wordCount,
    pageCount: parsed.pageCount,
    estimatedMinutes,
    warnings,
    noTextLayerPages: parsed.noTextLayerPages,
  });
}
