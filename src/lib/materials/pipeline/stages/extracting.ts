/**
 * 阶段 2：extracting —— 选解析器、抽正文、把解析快照落成派生资产。
 *
 * 为什么要把 `ParseResult` 存盘（`MaterialAsset(kind='PARSED_JSON')`）而不是
 * 一路留在内存里：ADR-05 的 tick 是「一次 HTTP 调用推进一个阶段」，两次调用之间
 * 进程可能已经回收（Serverless / 热更新），中间结果必须持久化；同时也让
 * `normalizing` 成为**纯 CPU** 阶段，重试时可以只重跑分块。
 *
 * 状态机约束：`extracting → normalizing`（成功）/ `→ failed`（PARSE_TIMEOUT /
 * NO_TEXT / ARCHIVE_LIMIT / 解析器异常）/ `→ partial`（**整篇**都没有文本层）。
 */

import { readFileSync } from 'node:fs';
import { MATERIAL_ERROR_MESSAGES_ZH, MATERIAL_LIMITS } from '@/lib/constants';
import { MaterialParseError } from '@/lib/materials/parsers/types';
import { prisma } from '@/lib/prisma';
import { resolveUploadPath, writeDerivedMaterialFile } from '@/lib/storage';
import { pickParser } from '../parseStage';
import {
  PARSED_SNAPSHOT_FILE,
  stageCancelled,
  stageFailure,
  type ParsedSnapshot,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from '../stageContract';

/** 给解析套一层超时：pdfjs 是异步的，超时后仍然让它自己跑完，但结果不采信。 */
async function parseWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PARSE_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 把解析快照写进 `MaterialAsset(kind='PARSED_JSON')`（重试时覆盖同一路径）。 */
async function saveParsedSnapshot(materialId: string, snapshot: ParsedSnapshot): Promise<void> {
  const buffer = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const stored = writeDerivedMaterialFile(buffer, materialId, PARSED_SNAPSHOT_FILE);
  await prisma.materialAsset.upsert({
    where: { materialId_relativePath: { materialId, relativePath: stored.relativePath } },
    create: {
      materialId,
      kind: 'PARSED_JSON',
      relativePath: stored.relativePath,
      fileName: PARSED_SNAPSHOT_FILE,
      mimeType: 'application/json',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      isReadOnly: false,
    },
    update: { sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
  });
}

export const extractingStage: StageHandler = async (ctx: StageContext): Promise<StageOutcome> => {
  const { material } = ctx;

  const parser = pickParser(material.format);
  if (!parser) {
    return stageFailure(
      'extracting',
      'UNSUPPORTED_FORMAT',
      MATERIAL_ERROR_MESSAGES_ZH.UNSUPPORTED_FORMAT ?? '暂不支持该文件格式',
    );
  }

  const asset = await prisma.materialAsset.findFirst({
    where: { materialId: material.id, kind: 'ORIGINAL_FILE' },
    select: { relativePath: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!asset) {
    return stageFailure('extracting', 'INVALID_MAGIC', '材料原文缺失，无法解析');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveUploadPath(asset.relativePath));
  } catch {
    return stageFailure('extracting', 'INVALID_MAGIC', '读取原文文件失败，请删除后重新导入');
  }

  const startedAt = Date.now();
  let parsed;
  try {
    parsed = await parseWithTimeout(
      Promise.resolve(parser.parse({ bytes })),
      MATERIAL_LIMITS.parseTimeoutMs,
    );
  } catch (error) {
    const timedOut =
      Date.now() - startedAt >= MATERIAL_LIMITS.parseTimeoutMs ||
      (error instanceof Error && error.message === 'PARSE_TIMEOUT');
    if (timedOut) {
      return stageFailure(
        'extracting',
        'PARSE_TIMEOUT',
        MATERIAL_ERROR_MESSAGES_ZH.PARSE_TIMEOUT ?? '解析超时，可重试或改用更小的文件',
      );
    }
    const code = error instanceof MaterialParseError ? error.code : 'INVALID_MAGIC';
    return stageFailure(
      'extracting',
      code,
      MATERIAL_ERROR_MESSAGES_ZH[code] ?? '解析失败，可重试或改用更小的文件',
    );
  }

  // 取消检查点（解析完成后的第一个 await 边界）
  if (await ctx.isCancelled()) return stageCancelled(ctx);

  // 整篇没有任何段落：扫描件 PDF 落 partial（可读但不可分析），其余格式直接 failed
  if (parsed.paragraphs.length === 0) {
    if (parsed.noTextLayerPages.length > 0) {
      return {
        to: 'partial',
        stage: 'extracting',
        progress: { done: 0, total: 1, unitLabel: '页面' },
        statusReason: `第 ${parsed.noTextLayerPages.join('、')} 页没有可提取的文本层（可能是扫描件），本材料暂时无法分析`,
        partial: {
          pages: parsed.noTextLayerPages,
          droppedElements: parsed.droppedElements,
          aiCallLimitHit: false,
        },
        jobStatus: 'succeeded',
        counts: { pageCount: parsed.pageCount, charCount: 0, wordCount: 0, chunkCount: 0 },
        didWork: true,
      };
    }
    return stageFailure(
      'extracting',
      'NO_TEXT',
      MATERIAL_ERROR_MESSAGES_ZH.NO_TEXT ?? '没有提取到任何文字',
      { pageCount: parsed.pageCount },
    );
  }

  try {
    await saveParsedSnapshot(material.id, {
      parserName: parsed.format,
      parserVersion: parser.parserVersion,
      parsed,
    });
  } catch {
    return stageFailure(
      'extracting',
      'INTERNAL_STORAGE',
      '解析结果写入失败（磁盘空间或权限问题），可重试',
    );
  }

  return {
    to: 'normalizing',
    stage: 'normalizing',
    progress: {
      done: parsed.paragraphs.length,
      total: parsed.paragraphs.length,
      unitLabel: '段落',
    },
    statusReason: null,
    counts: {
      pageCount: parsed.pageCount,
      charCount: parsed.charCount,
      wordCount: parsed.wordCount,
    },
    // 有扫描页但仍有可用正文：记进 partial 明细，最终状态由 normalizing 决定
    partial:
      parsed.noTextLayerPages.length > 0
        ? {
            pages: parsed.noTextLayerPages,
            droppedElements: parsed.droppedElements,
            aiCallLimitHit: false,
          }
        : undefined,
    didWork: true,
  };
};

/** 供 `normalizing` 复用的快照读取（读盘 + 解析 JSON，失败返回 null）。 */
export function loadParsedSnapshot(relativePath: string): ParsedSnapshot | null {
  try {
    const raw = readFileSync(resolveUploadPath(relativePath), 'utf8');
    const snapshot = JSON.parse(raw) as ParsedSnapshot;
    if (!snapshot?.parsed || !Array.isArray(snapshot.parsed.paragraphs)) return null;
    return snapshot;
  } catch {
    return null;
  }
}
