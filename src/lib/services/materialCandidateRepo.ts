/**
 * 词汇候选的物化（T12 §3）：**把「人已裁决的抽取结果」变成候选行**。
 *
 * 为什么需要这一步：全库在此之前**没有任何代码写 `VocabularyCandidate`**
 * （只有 count / delete）。没有物化，T10 的词汇辅助模式永远是空的，
 * 候选页也永远没有行 —— 词汇辅助功能实际上不存在。
 *
 * 四条设计判断：
 *
 * 1. **只物化人已采纳的抽取结果**（`accepted` / `edited`）：候选表是"待进词库的
 *    东西"，AI 随手给出的草稿不该出现在这里（否则用户要在一个 40 行的列表里
 *    先猜哪些是 AI 自说自话）。
 * 2. **`sourceQuote` 再回验一次**：`ExtractionResult` 入库时已经验过，但候选要
 *    独立成表、独立同步进词库，它必须**自带**能站得住的依据。多验一次的成本是
 *    一次字符串包含，收益是"词库里的每个词都能指回原文"。
 * 3. **幂等**：唯一键 `(materialId, normalizedLemma, pos, senseKey, contextHash)`。
 *    同一条抽取被裁决两次不能产生两条候选（AC-10）。SQLite 不支持
 *    `createMany({ skipDuplicates })`（那是 PG/MySQL 的能力），所以这里先按
 *    已有序号建 Set 预过滤，再逐条 `create` 并用唯一冲突兜底。
 * 4. **主库快照只是提示**：`existsInLibrary` / `existingItemId` 写的是"物化这一刻"
 *    的事实。同步时**必须**重新查一次（快照会过期：用户可能刚导入同名词条，
 *    也可能刚归档了它）。UI 也按现查结果显示（见 `queries/materials.ts`）。
 */

import { prisma } from '@/lib/prisma';
import { parseJson, stringify } from '@/lib/json';
import { canonicalPos } from '@/lib/domain/vocabImport';
import { buildContextHash, candidateKeyOf, normalizeMaterialLemma } from '@/lib/domain/lemmaNormalize';
import { verifySourceQuote } from '@/lib/materials/sourceVerify';

/** 能物化成词汇候选的抽取种别（只有这两类有 `lemma` 语义）。 */
export const CANDIDATE_SOURCE_KINDS = ['KEYWORD', 'COLLOCATION'] as const;

/** 允许物化的抽取裁决（必须是人做过的）。 */
export const CANDIDATE_SOURCE_REVIEW_STATUSES = ['accepted', 'edited'] as const;

export interface MaterializeResult {
  /** 新写入的候选数。 */
  created: number;
  /** 唯一键已存在而跳过的条数（幂等的证据）。 */
  duplicates: number;
  /** payload 里没有可用 `lemma` 的条数。 */
  skippedNoLemma: number;
  /** 原文依据二次回验没过（或段落快照缺失）的条数。 */
  skippedUnverifiable: number;
}

const EMPTY_RESULT: MaterializeResult = {
  created: 0,
  duplicates: 0,
  skippedNoLemma: 0,
  skippedUnverifiable: 0,
};

/**
 * 判断一个错误是否是唯一约束冲突（Prisma `P2002`）。
 *
 * 为什么不用 `instanceof Prisma.PrismaClientKnownRequestError`：这个模块被
 * Server Action 与测试同时引用，直接依赖生成客户端的运行时类会让 mock 环境
 * 里的判断失效。只读 `code` 字段足够稳定（Prisma 6 仍是 `P2002`）。
 *
 * @param error 任意被捕获的错误
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

/**
 * 在 `sourceQuote` 里找出该词**原文真实大小写**的词形。
 *
 * AI 给的 lemma 常常是词典形（小写），但原文里可能是句首大写的 `Quick`。
 * `surfaceForm` 要的是"它在文章里长什么样"，所以按忽略大小写定位、取原文切片。
 * 找不到（AI 给的是变形/同义词）就退回 lemma —— 不编造。
 *
 * @param sourceQuote 已通过回验的原文引用
 * @param lemma AI 给出的词元
 */
export function surfaceFormOf(sourceQuote: string, lemma: string): string {
  const quote = sourceQuote ?? '';
  const needle = (lemma ?? '').trim();
  if (needle.length === 0) return lemma;
  const at = quote.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return lemma;
  const found = quote.slice(at, at + needle.length);
  return found.trim().length > 0 ? found : lemma;
}

/**
 * 物化一份材料的词汇候选。
 *
 * 幂等：重复调用不会产生新行（`duplicates` 会累计）。
 *
 * @param materialId 材料 id
 */
export async function materializeVocabularyCandidates(
  materialId: string,
): Promise<MaterializeResult> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, language: true },
  });
  if (!material) return { ...EMPTY_RESULT };

  const rows = await prisma.extractionResult.findMany({
    where: {
      materialId,
      kind: { in: [...CANDIDATE_SOURCE_KINDS] },
      reviewStatus: { in: [...CANDIDATE_SOURCE_REVIEW_STATUSES] },
      chunkId: { not: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      chunkId: true,
      payloadJson: true,
      editedPayloadJson: true,
      sourceQuote: true,
      aiCallLogId: true,
    },
  });
  if (rows.length === 0) return { ...EMPTY_RESULT };

  const chunkIds = Array.from(
    new Set(
      rows.map((row) => row.chunkId).filter((id): id is string => typeof id === 'string'),
    ),
  );
  const chunkRows = await prisma.contentChunk.findMany({
    where: { id: { in: chunkIds } },
    select: {
      id: true,
      text: true,
      page: true,
      paragraphIndex: true,
      charStart: true,
      charEnd: true,
    },
  });
  const chunkById = new Map(chunkRows.map((chunk) => [chunk.id, chunk]));

  // 已存在的候选键：幂等的第一道闸（避免把"重复"当异常来打日志）
  const existing = await prisma.vocabularyCandidate.findMany({
    where: { materialId },
    select: { normalizedLemma: true, pos: true, senseKey: true, contextHash: true },
  });
  const seen = new Set(
    existing.map((row) => `${row.normalizedLemma}|${row.pos}|${row.senseKey}|${row.contextHash}`),
  );

  const result: MaterializeResult = { ...EMPTY_RESULT };

  interface Draft {
    chunkId: string;
    surfaceForm: string;
    lemma: string;
    normalizedLemma: string;
    pos: string;
    senseKey: string;
    definitionZh: string | null;
    definitionEn: string | null;
    collocationsJson: string | null;
    contextSentence: string;
    contextHash: string;
    page: number | null;
    paragraphIndex: number | null;
    charStart: number | null;
    charEnd: number | null;
    aiCallLogId: string | null;
  }

  const drafts: Draft[] = [];

  for (const row of rows) {
    if (!row.chunkId) {
      result.skippedUnverifiable += 1;
      continue;
    }
    const chunk = chunkById.get(row.chunkId);
    if (!chunk) {
      // 段落快照缺失（解析版本被替换等）→ 无法回验依据，宁可不建候选
      result.skippedUnverifiable += 1;
      continue;
    }

    // 用户改过的以 `editedPayloadJson` 为准（与 Reader 同源，绝不覆盖 AI 原始输出）
    const payload =
      parseJson<Record<string, unknown>>(row.editedPayloadJson ?? row.payloadJson, {}) ?? {};

    const lemmaRaw = typeof payload.lemma === 'string' ? payload.lemma : '';
    const lemma = lemmaRaw.trim();
    const normalizedLemma = normalizeMaterialLemma(lemmaRaw);
    if (lemma.length === 0 || normalizedLemma.length === 0) {
      result.skippedNoLemma += 1;
      continue;
    }

    const contextSentence = (row.sourceQuote ?? '').trim();
    const verified = verifySourceQuote(contextSentence, chunk.text);
    if (!verified.verified) {
      result.skippedUnverifiable += 1;
      continue;
    }

    const pos = canonicalPos(typeof payload.pos === 'string' ? payload.pos : null);
    const senseKey = 'default';
    const contextHash = buildContextHash(contextSentence);
    const key = `${candidateKeyOf(normalizedLemma, pos, senseKey)}|${contextHash}`;
    if (seen.has(key)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(key);

    const collocations = Array.isArray(payload.collocations)
      ? payload.collocations.filter((item): item is string => typeof item === 'string')
      : [];

    drafts.push({
      chunkId: row.chunkId,
      surfaceForm: surfaceFormOf(contextSentence, lemma),
      lemma,
      normalizedLemma,
      pos,
      senseKey,
      definitionZh:
        typeof payload.definition_zh === 'string' && payload.definition_zh.trim().length > 0
          ? payload.definition_zh.trim()
          : null,
      definitionEn:
        typeof payload.definition_en === 'string' && payload.definition_en.trim().length > 0
          ? payload.definition_en.trim()
          : null,
      collocationsJson: collocations.length > 0 ? stringify(collocations) : null,
      contextSentence,
      contextHash,
      page: chunk.page,
      paragraphIndex: chunk.paragraphIndex,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      aiCallLogId: row.aiCallLogId,
    });
  }

  if (drafts.length === 0) return result;

  // 主库快照（一次性批量查，避免 N+1）：同键同词性的词条已经存在吗
  const libraryLanguage = material.language || 'en';
  const libraryItems = await prisma.vocabularyItem.findMany({
    where: {
      language: libraryLanguage,
      archivedAt: null,
      normalizedLemma: { in: Array.from(new Set(drafts.map((draft) => draft.normalizedLemma))) },
    },
    select: { id: true, normalizedLemma: true, pos: true, senseKey: true },
  });
  const libraryByKey = new Map(
    libraryItems.map((item) => [candidateKeyOf(item.normalizedLemma, item.pos, item.senseKey), item.id]),
  );

  for (const draft of drafts) {
    const existingItemId =
      libraryByKey.get(candidateKeyOf(draft.normalizedLemma, draft.pos, draft.senseKey)) ?? null;
    try {
      await prisma.vocabularyCandidate.create({
        data: {
          materialId,
          chunkId: draft.chunkId,
          surfaceForm: draft.surfaceForm,
          lemma: draft.lemma,
          normalizedLemma: draft.normalizedLemma,
          pos: draft.pos,
          senseKey: draft.senseKey,
          definitionZh: draft.definitionZh,
          definitionEn: draft.definitionEn,
          collocationsJson: draft.collocationsJson,
          contextSentence: draft.contextSentence,
          contextHash: draft.contextHash,
          page: draft.page,
          paragraphIndex: draft.paragraphIndex,
          charStart: draft.charStart,
          charEnd: draft.charEnd,
          occurrenceCount: 1,
          existsInLibrary: existingItemId !== null,
          existingItemId,
          isDerived: true,
          aiCallLogId: draft.aiCallLogId,
          reviewStatus: 'draft',
          syncStatus: 'pending',
        },
        select: { id: true },
      });
      result.created += 1;
    } catch (error) {
      // 并发下唯一键被抢（预过滤没覆盖到的极端情况）：按重复处理，不吞其它错误
      if (isUniqueViolation(error)) {
        result.duplicates += 1;
        continue;
      }
      throw error;
    }
  }

  return result;
}
