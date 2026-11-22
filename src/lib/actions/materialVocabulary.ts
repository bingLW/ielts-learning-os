'use server';

/**
 * 材料词汇候选（T12）的六个 Server Action：裁决 → 批量采纳 → 同步 → 重试 → 跳过 → 补建。
 *
 * 统一约定与 `actions/materialAnalysis.ts` / `materialExercises.ts` 一致：
 * `safeParse` 失败走 `failValidation`、失败**返回**不 throw、写库后 `revalidatePath`。
 *
 * 这一层只做四件事 —— ① 前置断言；② 调纯函数拿结论（`decideSync` /
 * `normalizeMaterialLemma`）；③ 逐条写库；④ 结算材料状态。它**不自己判断**
 * "这个词该不该进词库"（`domain/materialVocabSync` 是唯一裁决点）、
 * "材料该不该 ready"（`services/materialReviewSettle` 是唯一落库点）。
 *
 * 同步的三条硬约束：
 * - **逐条独立事务**：一条失败只把该条置 `failed` + 人话原因，其余继续（E-06）；
 * - **E-04 只加来源**：主库已有同键词条时，一个字段都不改；
 * - **幂等**：连点两次同步，第二次 `created` / `linked` 必须都是 0。
 */

import { revalidatePath } from 'next/cache';
import {
  type MaterialReviewStatus,
  type MaterialStatus,
} from '@/lib/constants';
import type { ReviewGateResult } from '@/lib/domain/materialReviewGate';
import {
  buildContextHash,
  legacyLemmaKeyVariants,
  normalizeMaterialLemma,
  stripLemmaEdgePunctuation,
} from '@/lib/domain/lemmaNormalize';
import { decideSync } from '@/lib/domain/materialVocabSync';
import { canonicalPos } from '@/lib/domain/vocabImport';
import { prisma } from '@/lib/prisma';
import { fail, failValidation, ok } from '@/lib/result';
import {
  materializeCandidatesSchema,
  vocabCandidateBulkSchema,
  vocabCandidateIdSchema,
  vocabCandidateReviewSchema,
  vocabCandidateSyncSchema,
  type VocabCandidateReviewStatus,
} from '@/lib/schema/materialVocabulary';
import {
  isUniqueViolation,
  materializeVocabularyCandidates,
  type MaterializeResult,
} from '@/lib/services/materialCandidateRepo';
import { settleMaterialReviewStatus } from '@/lib/services/materialReviewSettle';
import type { ActionResult } from '@/lib/types';

/**
 * 允许裁决候选的材料状态。
 *
 * 比提取结果宽松（多一个 `ready`）：候选可以在材料定稿后才补建（§3 的补建按钮），
 * 那时材料已经是 `ready`，但"审不审这些词"仍然是用户的事。处理中的状态一律拒绝 ——
 * AI 还在产出，此时裁决等于对着半成品签收。
 */
const REVIEWABLE_MATERIAL_STATUSES: readonly MaterialStatus[] = [
  'review_required',
  'ready',
  'partial',
];

/** 同步错误的长度上限（与 `statusReason` 的口径一致：人话，不塞堆栈）。 */
const SYNC_ERROR_MAX = 200;

/** 材料侧所有相关页面的失效路径。 */
function revalidateVocabularyPaths(materialId: string): void {
  revalidatePath(`/materials/${materialId}/vocabulary`);
  revalidatePath(`/materials/${materialId}/analysis`);
  revalidatePath(`/materials/${materialId}/read`);
  revalidatePath('/materials');
}

interface MaterialBrief {
  id: string;
  title: string;
  status: MaterialStatus;
  /** 词条语言（`VocabularyItem.language` 必须与材料同语言，否则键不是一个空间）。 */
  language: string;
  license: string | null;
}

/** 读材料摘要（含许可证，同步时要写进 `VocabularyItem.license`）。 */
async function loadMaterial(materialId: string): Promise<MaterialBrief | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      title: true,
      status: true,
      language: true,
      source: { select: { licenseName: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status as MaterialStatus,
    language: row.language || 'en',
    license: row.source?.licenseName ?? null,
  };
}

/** 读当前状态（写库后回填 DTO，避免页面拿到旧值）。 */
async function readStatus(materialId: string, fallback: MaterialStatus): Promise<MaterialStatus> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { status: true },
  });
  return (row?.status as MaterialStatus) ?? fallback;
}

/**
 * 把异常压成一句可以给用户看的原因。
 *
 * 三条要求（与材料域其它 `statusReason` 一致）：不超 200 字、不含绝对路径、
 * 不含堆栈。绝对路径单独处理：Prisma 的错误信息里会带 `file:/Users/...`，
 * 直接把本机路径打到界面上既没用也泄漏环境信息。
 *
 * @param error 任意被捕获的错误
 */
function safeSyncError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw
    .replace(/\b(?:file:)?\/(?:Users|private|var|tmp|opt|home)\/[^\s'"，。；]*/g, '（路径已省略）')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return '同步失败（没有更多信息）';
  return stripped.length > SYNC_ERROR_MAX ? `${stripped.slice(0, SYNC_ERROR_MAX)}…` : stripped;
}

/** 成员来源备注（超过 200 字截断；`note` 只是给人看的辅助信息）。 */
function membershipNote(materialTitle: string): string {
  const note = `来自材料：${materialTitle}`;
  return note.length > SYNC_ERROR_MAX ? `${note.slice(0, SYNC_ERROR_MAX)}…` : note;
}

/** 在来源备注后面追加一句说明（同样受 200 字上限约束）。 */
function appendNote(base: string, suffix: string): string {
  const merged = `${base}${suffix}`;
  return merged.length > SYNC_ERROR_MAX ? `${merged.slice(0, SYNC_ERROR_MAX)}…` : merged;
}

// ───────────────────────── ① 单条裁决 ─────────────────────────

export interface ReviewVocabCandidateData {
  id: string;
  reviewStatus: VocabCandidateReviewStatus;
  lemma: string;
  normalizedLemma: string;
  pos: string;
  existsInLibrary: boolean;
  existingItemId: string | null;
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
}

/**
 * 裁决一条词汇候选。
 *
 * 三种裁决的语义：
 * - `accepted`：这个词没问题（释义可留可不用）；
 * - `edited`：我改了词条/词性/释义 —— **必须重算 `normalizedLemma` 与 `contextHash`**，
 *   否则候选身份键还指着旧词条，去重与「是否已在词库」都会答错；
 * - `rejected`：这个词不进词库（`syncStatus` 不动：它本来就没同步过，
 *   真正的"跳过"语义见 `skipVocabularyCandidateAction`）。
 *
 * @param raw `{ id, reviewStatus, lemma?, pos?, definitionZh? }`
 */
export async function reviewVocabularyCandidateAction(
  raw: unknown,
): Promise<ActionResult<ReviewVocabCandidateData>> {
  const parsed = vocabCandidateReviewSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const candidate = await prisma.vocabularyCandidate.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      materialId: true,
      contextSentence: true,
      lemma: true,
      normalizedLemma: true,
      pos: true,
      senseKey: true,
      syncStatus: true,
    },
  });
  if (!candidate) {
    return fail('NOT_FOUND', '这条词汇候选不存在，可能已被删除（可在词汇页重新补建）');
  }

  const material = await loadMaterial(candidate.materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', '材料还在处理中，现在还不能裁决词汇候选');
  }

  const reviewStatus = parsed.data.reviewStatus;

  if (reviewStatus === 'edited') {
    const lemmaInput = (parsed.data.lemma ?? '').trim();
    // 展示用词条：保留用户输入的大小写，只剥两端标点（`Clean,` → `Clean`）
    const displayLemma = stripLemmaEdgePunctuation(lemmaInput) || lemmaInput;
    const normalizedLemma = normalizeMaterialLemma(displayLemma);
    if (normalizedLemma.length === 0) {
      return fail('VALIDATION', '词条不能只有标点或空白', { lemma: '请输入有效的词条' });
    }
    const pos = canonicalPos(parsed.data.pos ?? candidate.pos);
    // 身份键重算：句子没变，但函数仍重算一次 —— 「改了词条就重算哈希」这条
    // 口径必须由代码表达，而不是靠"句子没变所以不用算"的推断。
    const contextHash = buildContextHash(candidate.contextSentence);

    const clash = await prisma.vocabularyCandidate.findFirst({
      where: {
        materialId: candidate.materialId,
        normalizedLemma,
        pos,
        senseKey: candidate.senseKey,
        contextHash,
        id: { not: candidate.id },
      },
      select: { id: true },
    });
    if (clash) {
      return fail('VALIDATION', '该词已在候选列表中（同一句原文下词条+词性重复）', {
        lemma: '与现有候选重复，请直接编辑那一条',
      });
    }

    const libraryItemId = await findLibraryItemId({
      language: material.language,
      normalizedLemma,
      pos,
      senseKey: candidate.senseKey,
      rawLemma: displayLemma,
    });

    await prisma.vocabularyCandidate.update({
      where: { id: candidate.id },
      data: {
        lemma: displayLemma,
        normalizedLemma,
        pos,
        contextHash,
        // 空串表示"清空释义"：只有显式传了才改，没传就保留原值
        ...(parsed.data.definitionZh !== undefined
          ? { definitionZh: parsed.data.definitionZh.trim() || null }
          : {}),
        reviewStatus: 'edited',
        // 快照跟着更新（快照只是提示，但让它尽量新没有坏处）
        existsInLibrary: libraryItemId !== null,
        existingItemId: libraryItemId,
      },
    });
  } else {
    await prisma.vocabularyCandidate.update({
      where: { id: candidate.id },
      data: { reviewStatus },
    });
  }

  const gate = await settleMaterialReviewStatus(candidate.materialId);
  const materialStatus = await readStatus(candidate.materialId, material.status);
  revalidateVocabularyPaths(candidate.materialId);

  const after = await prisma.vocabularyCandidate.findUnique({
    where: { id: candidate.id },
    select: {
      lemma: true,
      normalizedLemma: true,
      pos: true,
      existsInLibrary: true,
      existingItemId: true,
    },
  });

  return ok<ReviewVocabCandidateData>({
    id: candidate.id,
    reviewStatus,
    lemma: after?.lemma ?? candidate.lemma,
    normalizedLemma: after?.normalizedLemma ?? candidate.normalizedLemma,
    pos: after?.pos ?? candidate.pos,
    existsInLibrary: after?.existsInLibrary ?? false,
    existingItemId: after?.existingItemId ?? null,
    materialStatus,
    gate,
  });
}

/** 主库同键词条 id（同步与快照共用同一查询口径）。 */
async function findLibraryItemId(input: {
  language: string;
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  rawLemma: string;
}): Promise<string | null> {
  const resolved = await resolveLibraryItem(input);
  return resolved?.itemId ?? null;
}

/**
 * 主库里与该候选对应的词条（含**历史归一化键**的兜底探测）。
 *
 * 为什么需要兜底：`normalizeLemma` 在 T12 加了四条折叠（NFD→NFC、零宽、全角、
 * 弯引号），而库里 v2.3 起的词条键是用**旧算法**算的。键不会自动更新，于是
 * 「`don’t`（旧键 `don’t`）在库里、候选是新键 `don't`」这种情况按新键查不到，
 * 一查不到就会 `create` —— 用户词库里凭空多出第二个 `don't`，而且没有任何报错。
 * E-04「已存在只加来源」在这批词上会**静默失效**。
 *
 * 探测分四级，**只做读**，从不回写库里的 `normalizedLemma`（那是用户数据）：
 * 0. 当前算法的新键（正常路径，索引命中）；
 * 1. 原文逐字相同（`lemma === 候选 lemma`，覆盖大小写/符号被人工改过的历史行）；
 * 2. 候选词条的各种等价拼写形式算出的**旧键**（`IN`，索引命中，覆盖 99% 的漂移）；
 * 3. 用最长的 ASCII 片段做 SQL 侧粗筛 + JS 侧用当前算法复算（零宽字符这类
 *    无法枚举插入位置的漂移只能靠扫描兜底；`contains` 让 SQLite 先过滤，
 *    不会把整库读进内存）。
 *
 * @param input 候选的键与原始词条
 * @returns 命中的词条 id 与「是否走了历史键兜底」
 */
async function resolveLibraryItem(input: {
  language: string;
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  rawLemma: string;
}): Promise<{ itemId: string; legacyMatched: boolean; sourceCount: number } | null> {
  const base = {
    language: input.language,
    pos: input.pos,
    senseKey: input.senseKey,
    archivedAt: null,
  } as const;

  // ── 0：新键（正常路径） ──
  const exact = await prisma.vocabularyItem.findFirst({
    where: { ...base, normalizedLemma: input.normalizedLemma },
    select: { id: true, _count: { select: { memberships: true } } },
  });
  if (exact) {
    return { itemId: exact.id, legacyMatched: false, sourceCount: exact._count.memberships };
  }

  // ── 1：原文逐字相同 ──
  const raw = input.rawLemma.trim();
  if (raw.length > 0) {
    const byLemma = await prisma.vocabularyItem.findFirst({
      where: { ...base, lemma: raw },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (byLemma) return { itemId: byLemma.id, legacyMatched: true, sourceCount: 0 };
  }

  // ── 2：等价拼写形式的旧键 ──
  const legacyKeys = legacyLemmaKeyVariants(raw).filter(
    (key) => key !== input.normalizedLemma,
  );
  if (legacyKeys.length > 0) {
    const byLegacyKey = await prisma.vocabularyItem.findFirst({
      where: { ...base, normalizedLemma: { in: legacyKeys } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (byLegacyKey) return { itemId: byLegacyKey.id, legacyMatched: true, sourceCount: 0 };
  }

  // ── 3：粗筛 + 复算（兜零宽这类无法枚举的漂移） ──
  const asciiRuns = raw.match(/[A-Za-z0-9]{2,}/g) ?? [];
  const fragment = asciiRuns.sort((left, right) => right.length - left.length)[0] ?? '';
  if (fragment.length < 2) return null;

  const coarse = await prisma.vocabularyItem.findMany({
    where: { ...base, lemma: { contains: fragment } },
    select: { id: true, lemma: true, normalizedLemma: true },
  });
  const drift = coarse.find(
    (row) => normalizeMaterialLemma(row.lemma) === input.normalizedLemma,
  );
  return drift ? { itemId: drift.id, legacyMatched: true, sourceCount: 0 } : null;
}

// ───────────────────────── ② 批量采纳 ─────────────────────────

export interface BulkAcceptVocabCandidatesData {
  /** 真正被更新的行数（0 不是错误：可能别人已经处理过）。 */
  updated: number;
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
}

/**
 * 批量采纳（只对 `draft` 生效）。
 *
 * 为什么 `updateMany` 要带 `materialId`：`ids` 来自前端，只按 id 更新就能跨材料
 * 改数据。带上 `materialId` 之后越权 id 自然变成 0 行（**不报错**，也不泄漏
 * "这条 id 存在"的信息）。
 *
 * 为什么还带 `reviewStatus: 'draft'`：批量采纳是"把还没表态的一批一起采纳"，
 * 不该把已经 `rejected` 的候选悄悄翻回来（那是另一个动作）。
 *
 * @param raw `{ materialId, ids }`
 */
export async function bulkAcceptVocabularyCandidatesAction(
  raw: unknown,
): Promise<ActionResult<BulkAcceptVocabCandidatesData>> {
  const parsed = vocabCandidateBulkSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, ids } = parsed.data;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', '材料还在处理中，现在还不能批量采纳词汇候选');
  }

  const result = await prisma.vocabularyCandidate.updateMany({
    where: { materialId, id: { in: ids }, reviewStatus: 'draft' },
    data: { reviewStatus: 'accepted' },
  });

  const gate = await settleMaterialReviewStatus(materialId);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateVocabularyPaths(materialId);

  return ok<BulkAcceptVocabCandidatesData>({
    updated: result.count,
    materialStatus,
    gate,
  });
}

// ───────────────────────── ③ 同步 ─────────────────────────

export interface SyncVocabCandidatesData {
  /** 新建的词条数。 */
  created: number;
  /** 只追加来源（词库已有该词）的条数。 */
  linked: number;
  /** 跳过（来源已存在 / 状态不允许）的条数。 */
  skipped: number;
  /** 失败并标记为可重试的条数（E-06）。 */
  failed: number;
  /**
   * 其中有多少条是**按原词形/旧键**匹配到历史词条的（归一化键是旧版本）。
   *
   * 单独一个计数而不是只塞进备注：这类命中意味着"库里那条词的键该重算了"，
   * 用户看不到就会一直以为词库是干净的。
   */
  legacyMatched: number;
  materialStatus: MaterialStatus;
}

interface SyncCandidateRow {
  id: string;
  lemma: string;
  surfaceForm: string;
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  definitionZh: string | null;
  definitionEn: string | null;
  collocationsJson: string | null;
  reviewStatus: string;
  syncStatus: string;
}

interface SyncContext {
  materialId: string;
  materialTitle: string;
  license: string | null;
  sourceId: string;
  language: string;
}

/** 把一条候选标记成已同步。 */
async function markSynced(candidateId: string, itemId: string): Promise<void> {
  await prisma.vocabularyCandidate.update({
    where: { id: candidateId },
    data: {
      syncStatus: 'synced',
      syncedItemId: itemId,
      lastSyncedAt: new Date(),
      syncError: null,
      existsInLibrary: true,
      existingItemId: itemId,
    },
  });
}

/** 把一条候选标记成失败（E-06：可重试，所以只写 `failed` 不动审核状态）。 */
async function markFailed(candidateId: string, error: unknown): Promise<void> {
  try {
    await prisma.vocabularyCandidate.update({
      where: { id: candidateId },
      data: { syncStatus: 'failed', syncError: safeSyncError(error) },
    });
  } catch {
    // 连标记失败都失败（数据库不可用）：不掩盖原始错误，交给上层计数
  }
}

/** 历史键兜底命中时，写进来源备注的后缀（让用户看得到"发生过什么"）。 */
const LEGACY_MATCH_NOTE = '（按原词形匹配到历史词条，归一化键为旧版本）';

/**
 * 「已有词条 → 只加来源」（E-04）。
 *
 * 唯一约束 `(itemId, sourceId, sourceRef)` 冲突 = 这个来源早就记过了：
 * 对用户来说是"跳过"，但候选本身**确实**已经同步到位，所以仍标记成 `synced`。
 *
 * @param resolved 已经解析好的主库词条；缺省时自己再解析一次（仅并发竞态下的兜底路径）
 */
async function syncAddSource(
  candidate: SyncCandidateRow,
  ctx: SyncContext,
  resolved?: { itemId: string; legacyMatched: boolean },
): Promise<'linked' | 'skipped'> {
  const target =
    resolved ??
    (await resolveLibraryItem({
      language: ctx.language,
      normalizedLemma: candidate.normalizedLemma,
      pos: candidate.pos,
      senseKey: candidate.senseKey,
      rawLemma: candidate.lemma,
    }));

  if (!target) {
    /**
     * 「建不了也加不了来源」的唯一现实成因：词库里有一条**同键但已归档**的词条。
     * 归档只是业务标记，唯一索引照样占着位置，所以 `create` 会撞 P2002。
     *
     * 这里刻意**不自动恢复**那条已归档词条：用户当初归档它就是有意的，
     * 系统替他"复活"一个词比报错更糟。给一句能照着做的话，让他自己决定。
     */
    const archived = await prisma.vocabularyItem.findFirst({
      where: {
        language: ctx.language,
        normalizedLemma: candidate.normalizedLemma,
        pos: candidate.pos,
        senseKey: candidate.senseKey,
        archivedAt: { not: null },
      },
      select: { id: true },
    });
    if (archived) {
      throw new Error(
        '词库里有一条同名的已归档词条，请先在词库页恢复（或删除）它，再回来点「重试失败项」',
      );
    }
    throw new Error('词库里的同名词条在同步过程中消失了，请稍后重试');
  }

  const itemId = target.itemId;
  const note = target.legacyMatched
    ? appendNote(membershipNote(ctx.materialTitle), LEGACY_MATCH_NOTE)
    : membershipNote(ctx.materialTitle);

  let linked = false;
  await prisma.$transaction(async (tx) => {
    // 先查再建：**「这个来源已经记过了」是正常业务分支**，不该靠捕获异常来发现。
    // （异常仍然兜底，防并发；但常见路径不该在日志里刷出一条 Invalid invocation。）
    const existing = await tx.vocabularyItemSource.findFirst({
      where: { itemId, sourceId: ctx.sourceId, sourceRef: ctx.materialId },
      select: { id: true },
    });
    if (existing) return;

    try {
      await tx.vocabularyItemSource.create({
        data: {
          itemId,
          sourceId: ctx.sourceId,
          sourceRef: ctx.materialId,
          note,
        },
      });
      linked = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // 并发下别人刚记过：不重复记，也不改词条
    }
  });

  await markSynced(candidate.id, itemId);
  return linked ? 'linked' : 'skipped';
}

/**
 * 同步一条候选（独立事务；失败只影响这一条）。
 *
 * @returns `outcome` 用于计数，`legacyMatched` 表示"命中的是历史归一化键"
 */
async function syncOneCandidate(
  candidate: SyncCandidateRow,
  ctx: SyncContext,
): Promise<{ outcome: 'created' | 'linked' | 'skipped'; legacyMatched: boolean }> {
  // **现查**主库（不能用物化时的快照：快照会过期），并带历史键兜底
  const library = await resolveLibraryItem({
    language: ctx.language,
    normalizedLemma: candidate.normalizedLemma,
    pos: candidate.pos,
    senseKey: candidate.senseKey,
    rawLemma: candidate.lemma,
  });

  const decision = decideSync({
    candidateReviewStatus: candidate.reviewStatus,
    syncStatus: candidate.syncStatus,
    libraryItem: library
      ? { id: library.itemId, sourceCount: library.sourceCount }
      : null,
  });

  if (decision.action === 'skip') {
    // 查询条件已经把「未采纳」「已同步」的行排除在外，所以这里只可能是
    // 并发/脏数据导致的兜底：不写库、不改状态，让它留在待同步队列里等下一次。
    return { outcome: 'skipped', legacyMatched: false };
  }

  if (decision.action === 'add_source') {
    const outcome = await syncAddSource(candidate, ctx, {
      itemId: library?.itemId ?? '',
      legacyMatched: library?.legacyMatched ?? false,
    });
    return { outcome, legacyMatched: library?.legacyMatched ?? false };
  }

  // create
  /**
   * 先看有没有「同键但已归档」的词条。
   *
   * 归档只是业务标记，唯一索引照样占着位置 —— 直接 `create` 必然撞 P2002，
   * 而那条 P2002 会被下面的 fallback 当成"并发抢先"，最后给出一句含糊的
   * "词条消失了"。所以这里**先判**，直接给出能照着做的原因。
   *
   * 刻意**不自动恢复**那条已归档词条：用户当初归档它就是有意的，
   * 系统替他"复活"一个词比报错更糟。
   */
  const archived = await prisma.vocabularyItem.findFirst({
    where: {
      language: ctx.language,
      normalizedLemma: candidate.normalizedLemma,
      pos: candidate.pos,
      senseKey: candidate.senseKey,
      archivedAt: { not: null },
    },
    select: { id: true },
  });
  if (archived) {
    throw new Error(
      '词库里有一条同名的已归档词条，请先在词库页恢复（或删除）它，再回来点「重试失败项」',
    );
  }

  try {
    const itemId = await prisma.$transaction(async (tx) => {
      const item = await tx.vocabularyItem.create({
        data: {
          lemma: candidate.lemma,
          displayForm: candidate.surfaceForm,
          normalizedLemma: candidate.normalizedLemma,
          pos: candidate.pos,
          language: ctx.language,
          senseKey: candidate.senseKey,
          definitionZh: candidate.definitionZh,
          definitionEn: candidate.definitionEn,
          collocationsJson: candidate.collocationsJson,
          sourceId: ctx.sourceId,
          sourceRef: ctx.materialId,
          license: ctx.license,
        },
        select: { id: true },
      });
      await tx.vocabularyItemSource.create({
        data: {
          itemId: item.id,
          sourceId: ctx.sourceId,
          sourceRef: ctx.materialId,
          note: membershipNote(ctx.materialTitle),
        },
      });
      return item.id;
    });
    await markSynced(candidate.id, itemId);
    return { outcome: 'created', legacyMatched: false };
  } catch (error) {
    // 并发下同键词条被别处抢先建了（唯一约束）：退化成"只加来源"，不新建第二条
    if (!isUniqueViolation(error)) throw error;
    const outcome = await syncAddSource(candidate, ctx);
    return { outcome, legacyMatched: false };
  }
}

/**
 * 执行同步（③④ 共用这一份实现，避免两份"同步语义"）。
 *
 * @param materialId 材料 id
 * @param ids 只同步指定候选（缺省 = 全部符合条件的）
 */
async function performSync(
  materialId: string,
  ids: readonly string[] | null,
): Promise<SyncVocabCandidatesData & { materialStatus: MaterialStatus }> {
  const material = await loadMaterial(materialId);
  if (!material) throw new Error('材料不存在或已被删除');

  const sourceId = await ensureMaterialVocabularySource(material.title, material.license);

  const candidates = await prisma.vocabularyCandidate.findMany({
    where: {
      materialId,
      reviewStatus: { in: ['accepted', 'edited'] },
      syncStatus: { in: ['pending', 'failed'] },
      ...(ids ? { id: { in: [...ids] } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      lemma: true,
      surfaceForm: true,
      normalizedLemma: true,
      pos: true,
      senseKey: true,
      definitionZh: true,
      definitionEn: true,
      collocationsJson: true,
      reviewStatus: true,
      syncStatus: true,
    },
  });

  const ctx: SyncContext = {
    materialId,
    materialTitle: material.title,
    license: material.license,
    sourceId,
    language: material.language,
  };

  let created = 0;
  let linked = 0;
  let skipped = 0;
  let failed = 0;
  let legacyMatched = 0;

  for (const candidate of candidates) {
    try {
      const result = await syncOneCandidate(candidate, ctx);
      if (result.outcome === 'created') created += 1;
      else if (result.outcome === 'linked') linked += 1;
      else skipped += 1;
      if (result.legacyMatched) legacyMatched += 1;
    } catch (error) {
      failed += 1;
      await markFailed(candidate.id, error);
    }
  }

  return { created, linked, skipped, failed, legacyMatched, materialStatus: material.status };
}

/**
 * 材料的词库来源（`VocabularySource{sourceType:'MATERIAL', title}`，按标题复用）。
 *
 * 为什么按标题复用而不是每份材料建一个：同一篇文章"另存副本"或重复导入时，
 * 词库里应该只有一个来源，否则"这个词来自哪些材料"会变成一串同义条目。
 */
async function ensureMaterialVocabularySource(
  title: string,
  license: string | null,
): Promise<string> {
  const existing = await prisma.vocabularySource.findFirst({
    where: { sourceType: 'MATERIAL', title },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.vocabularySource.create({
    data: { sourceType: 'MATERIAL', title, license },
    select: { id: true },
  });
  return created.id;
}

/**
 * 把已采纳的候选同步进主库。
 *
 * 主库已有同键词条时**只加来源**（E-04）；`created` / `linked` 之外的候选计
 * `skipped`（来源已记过）。逐条独立事务，一条失败不影响其余（E-06）。
 *
 * @param raw `{ materialId, ids? }`
 */
export async function syncVocabularyCandidatesAction(
  raw: unknown,
): Promise<ActionResult<SyncVocabCandidatesData>> {
  const parsed = vocabCandidateSyncSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId, ids } = parsed.data;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', '材料还在处理中，现在还不能同步词汇');
  }

  const summary = await performSync(materialId, ids ?? null);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateVocabularyPaths(materialId);

  return ok<SyncVocabCandidatesData>({ ...summary, materialStatus });
}

// ───────────────────────── ④ 重试失败项 ─────────────────────────

export interface RetryVocabSyncData {
  /** 被重置为待同步的条数。 */
  reset: number;
  created: number;
  linked: number;
  skipped: number;
  failed: number;
  legacyMatched: number;
  materialStatus: MaterialStatus;
}

/**
 * 重试同步失败项（E-06）。
 *
 * 实现上刻意**复用 `performSync`**：重置 + 同步是两步，但不该有两份同步逻辑。
 * 重置只动 `failed`，不碰 `pending`（后者本来就在待同步队列里）。
 *
 * @param raw `{ materialId }`
 */
export async function retryVocabularySyncAction(
  raw: unknown,
): Promise<ActionResult<RetryVocabSyncData>> {
  const parsed = materializeCandidatesSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId } = parsed.data;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', '材料还在处理中，现在还不能重试同步');
  }

  const reset = await prisma.vocabularyCandidate.updateMany({
    where: { materialId, syncStatus: 'failed' },
    data: { syncStatus: 'pending', syncError: null },
  });

  const summary = await performSync(materialId, null);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateVocabularyPaths(materialId);

  return ok<RetryVocabSyncData>({
    reset: reset.count,
    created: summary.created,
    linked: summary.linked,
    skipped: summary.skipped,
    failed: summary.failed,
    legacyMatched: summary.legacyMatched,
    materialStatus,
  });
}

// ───────────────────────── ⑤ 跳过（不进词库） ─────────────────────────

export interface SkipVocabCandidateData {
  id: string;
  reviewStatus: MaterialReviewStatus;
  syncStatus: string;
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
}

/**
 * 跳过一条候选："这个词我不要"。
 *
 * **两个字段必须一起改**：`reviewStatus='rejected'` + `syncStatus='skipped'`。
 * 只改一个会留下「已拒绝但待同步」这种自相矛盾的状态 —— 用户在同步结果里会看到
 * 一条永远不会成功的待同步项，而且没有任何操作能让它消失。
 *
 * @param raw `{ id }`
 */
export async function skipVocabularyCandidateAction(
  raw: unknown,
): Promise<ActionResult<SkipVocabCandidateData>> {
  const parsed = vocabCandidateIdSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const candidate = await prisma.vocabularyCandidate.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, materialId: true, syncStatus: true },
  });
  if (!candidate) return fail('NOT_FOUND', '这条词汇候选不存在，可能已被删除');

  const material = await loadMaterial(candidate.materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');
  if (!REVIEWABLE_MATERIAL_STATUSES.includes(material.status)) {
    return fail('PRECONDITION', '材料还在处理中，现在还不能跳过词汇候选');
  }
  if (candidate.syncStatus === 'synced') {
    return fail('PRECONDITION', '这条词已经同步进词库了，跳过不会把它从词库里删掉');
  }

  await prisma.vocabularyCandidate.update({
    where: { id: candidate.id },
    data: { reviewStatus: 'rejected', syncStatus: 'skipped', syncError: null },
  });

  const gate = await settleMaterialReviewStatus(candidate.materialId);
  const materialStatus = await readStatus(candidate.materialId, material.status);
  revalidateVocabularyPaths(candidate.materialId);

  return ok<SkipVocabCandidateData>({
    id: candidate.id,
    reviewStatus: 'rejected',
    syncStatus: 'skipped',
    materialStatus,
    gate,
  });
}

// ───────────────────────── ⑥ 补建候选 ─────────────────────────

export interface MaterializeVocabCandidatesData extends MaterializeResult {
  materialStatus: MaterialStatus;
  gate: ReviewGateResult;
}

/**
 * 从**已审核**的分析结果补建候选。
 *
 * 为什么需要这个入口：T12 之前审核过的材料，它的关键词语句早就裁决完了，
 * 但那时候还没有物化逻辑 —— 不补建，这些材料的词汇辅助模式永远是空的。
 *
 * 物化是幂等的（重复点只会让 `duplicates` 变大），所以按钮可以放心连点。
 *
 * @param raw `{ materialId }`
 */
export async function materializeVocabularyCandidatesAction(
  raw: unknown,
): Promise<ActionResult<MaterializeVocabCandidatesData>> {
  const parsed = materializeCandidatesSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const { materialId } = parsed.data;
  const material = await loadMaterial(materialId);
  if (!material) return fail('NOT_FOUND', '材料不存在或已被删除');

  const result = await materializeVocabularyCandidates(materialId);
  // 候选是 `draft` → 材料必须留在（或回到）待审核
  const gate = await settleMaterialReviewStatus(materialId);
  const materialStatus = await readStatus(materialId, material.status);
  revalidateVocabularyPaths(materialId);

  return ok<MaterializeVocabCandidatesData>({ ...result, materialStatus, gate });
}
