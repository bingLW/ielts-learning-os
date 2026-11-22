/**
 * 解析落库仓储（T07）。
 *
 * 唯一职责：把「一次解析的产物」原子地写进 `ParsedDocument` + `ContentChunk`。
 *
 * 刻意**不提供**任何 update / delete 方法 —— 原文不可覆写（B-06）：
 * 重跑解析只会产生 `version+1` 的新文档 + 新 chunk 集，旧版本保留可追溯。
 * 这条约束写在仓储层，比写在文档里可靠。
 */

import { prisma } from '@/lib/prisma';
import { createLocalId } from '@/lib/materials/id';
import type { ChunkDraft } from '@/lib/materials/chunk';

export interface CreateParsedDocumentInput {
  materialId: string;
  /** 解析器名（TXT / MARKDOWN / HTML / DOCX / PDF）。 */
  parserName: string;
  parserVersion: string;
  status: 'OK' | 'PARTIAL';
  pageCount: number | null;
  paragraphCount: number;
  charCount: number;
  /** `ParsedDocument.warningsJson`：结构化告警（JSON 字符串）。 */
  warningsJson: string | null;
  /** 纯文本快照 sha256（防篡改校验）。 */
  textChecksum: string | null;
  chunks: readonly ChunkDraft[];
}

export interface CreatedParsedDocument {
  parsedDocumentId: string;
  version: number;
  chunkCount: number;
}

/**
 * 在一个事务内：停用旧版本 → 建新 `ParsedDocument` → 批量写 chunk（含 prev/next 链）。
 *
 * 为什么 prev/next 用预生成 id：chunk 之间是**同批插入**的兄弟关系，
 * 没有数据库自增序号可用；先生成 id 再落库，可以保证链条在一次插入里完整。
 */
export async function createParsedDocumentWithChunks(
  input: CreateParsedDocumentInput,
): Promise<CreatedParsedDocument> {
  const chunkIds = input.chunks.map(() => createLocalId('ck'));

  return prisma.$transaction(async (tx) => {
    const latest = await tx.parsedDocument.aggregate({
      where: { materialId: input.materialId },
      _max: { version: true },
    });
    const version = (latest._max.version ?? 0) + 1;

    await tx.parsedDocument.updateMany({
      where: { materialId: input.materialId, isCurrent: true },
      data: { isCurrent: false },
    });

    const document = await tx.parsedDocument.create({
      data: {
        materialId: input.materialId,
        version,
        parserName: input.parserName,
        parserVersion: input.parserVersion,
        status: input.status,
        pageCount: input.pageCount,
        paragraphCount: input.paragraphCount,
        charCount: input.charCount,
        warningsJson: input.warningsJson,
        textChecksum: input.textChecksum,
        isCurrent: true,
      },
      select: { id: true },
    });

    if (input.chunks.length > 0) {
      await tx.contentChunk.createMany({
        data: input.chunks.map((chunk, index) => ({
          id: chunkIds[index],
          materialId: input.materialId,
          parsedDocumentId: document.id,
          seq: chunk.seq,
          kind: chunk.kind,
          headingPath: chunk.headingPath,
          page: chunk.page,
          paragraphIndex: chunk.paragraphIndex,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          text: chunk.text,
          textHash: chunk.textHash,
          charCount: chunk.charCount,
          estTokens: chunk.estTokens,
          // 注入疑似标记由 T09 的分析阶段回填；解析阶段只存原文
          suspicionFlags: null,
          prevChunkId: index > 0 ? chunkIds[index - 1] : null,
          nextChunkId: index < chunkIds.length - 1 ? chunkIds[index + 1] : null,
        })),
      });
    }

    return { parsedDocumentId: document.id, version, chunkCount: input.chunks.length };
  });
}

/** 读取某解析版本的全部 chunk（按 seq 升序）。只读，无副作用。 */
export async function getChunksByDocument(parsedDocumentId: string) {
  return prisma.contentChunk.findMany({
    where: { parsedDocumentId },
    orderBy: { seq: 'asc' },
  });
}

/** 读取材料当前生效版本的 chunk（供 Reader / 分析阶段使用）。 */
export async function getCurrentChunks(materialId: string) {
  const document = await prisma.parsedDocument.findFirst({
    where: { materialId, isCurrent: true },
    select: { id: true },
  });
  if (!document) return [];
  return getChunksByDocument(document.id);
}
