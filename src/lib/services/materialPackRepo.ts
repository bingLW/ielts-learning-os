/**
 * 材料包构建（T13 §3，AC-06）。
 *
 * **这个模块只有一条不可协商的规则：只聚合引用，不复制内容。**
 *
 * `MaterialPackItem` 里存的是 `refId`（指向 `ContentChunk` / `ExtractionResult` /
 * `VocabularyCandidate` / `MaterialExerciseSet` 的 id），不是原文、不是题干。
 * 理由不是"省空间"，而是**一致性**：一旦把正文复制进包表，原文修订/题目改写
 * 之后包里的副本就是旧内容，而这种"看起来对、实际过期"的数据没有任何报错。
 *
 * 被引用对象被删掉时，条目**不删**（`refId` 是弱引用），由查询层解析成 null，
 * 页面显示「内容已移除」。这样用户能看到"这里本来有东西，现在没了"，
 * 而不是包凭空少了一块。
 *
 * 时长与技能是"派生字段"，每次重建都按当前引用重算：
 * - `estimatedMinutes` = 各条目分钟之和，**向下取整到 5 分钟**（草案拆分要吃这个数）；
 * - `targetSkillsJson` = 条目技能的并集；
 * - `learningGoalsJson` 只来自 SUMMARY（AI 衍生，UI 必须挂 AI 徽章）。
 */

import { prisma } from '@/lib/prisma';

/** 条目类型（与 `MaterialPackItem.itemType` 的注释一致）。 */
export const PACK_ITEM_TYPES = [
  'EXERCISE_SET',
  'VOCAB_CANDIDATE',
  'EXTRACTION',
  'CHUNK',
  'SENTENCE',
] as const;
export type PackItemType = (typeof PACK_ITEM_TYPES)[number];

/** 允许进包的抽取项审核状态（只有人确认过的才进包）。 */
const PACK_EXTRACTION_REVIEW_STATUSES = ['accepted', 'edited'] as const;

/** 进包的词汇候选审核状态（与同步同口径）。 */
const PACK_CANDIDATE_REVIEW_STATUSES = ['accepted', 'edited'] as const;

/** 精读段落最多收几条（再多就不叫"先读哪几段"了）。 */
export const PACK_CHUNK_LIMIT = 20;

/** 每条精读段落的建议分钟（按段落体量给个固定值，避免用字数算出一堆怪数字）。 */
const CHUNK_MINUTES = 5;

/** 单条词汇候选复习的建议分钟（聚合为一条 `VOCAB_REVIEW`）。 */
const VOCAB_REVIEW_MINUTES = 10;

/** 单条重点句的建议分钟。 */
const SENTENCE_MINUTES = 5;

export interface BuildPackOptions {
  /** true = 清空旧条目重建（同事务）。 */
  rebuild?: boolean;
}

export interface BuildPackResult {
  packId: string;
  materialId: string;
  /** 本次是否真的重建了（已存在且未要求重建时为 false）。 */
  rebuilt: boolean;
  itemCount: number;
  estimatedMinutes: number;
  summaryId: string | null;
}

/** 把分钟数向下取整到 5 分钟的倍数（0 保持 0）。 */
function floorToFive(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.floor(minutes / 5) * 5;
}

/** 并集且顺序确定（按传入顺序去重，保证重建结果可复现）。 */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 构建/补建材料包。
 *
 * @param materialId 材料 id
 * @param options `rebuild=true` 时清空旧条目重建
 */
export async function buildMaterialPack(
  materialId: string,
  options: BuildPackOptions = {},
): Promise<BuildPackResult> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, difficultyEstimate: true },
  });
  if (!material) throw new Error('材料不存在或已被删除');

  const existing = await prisma.materialPack.findUnique({
    where: { materialId },
    select: { id: true, estimatedMinutes: true, summaryId: true },
  });

  // 已建过且没要求重建 → 原样返回（幂等：连点两次不会把 sortOrder 洗乱）
  if (existing && !options.rebuild) {
    const itemCount = await prisma.materialPackItem.count({ where: { packId: existing.id } });
    return {
      packId: existing.id,
      materialId,
      rebuilt: false,
      itemCount,
      estimatedMinutes: existing.estimatedMinutes,
      summaryId: existing.summaryId,
    };
  }

  // ── 聚合四类引用（并发读，互不依赖） ──
  //
  // 词汇候选/重点句要**聚合成一条**复习任务（逐个排会让草案膨胀成上百条），
  // 但仍需要一个真实的 `refId` 挂在条目上 —— `refId` 必须指向 `itemType`
  // 对应的那张表，否则查询层按表解析时会解错类型。
  const [exerciseSets, candidateFirst, candidateCount, summaryRows, sentenceFirst, sentenceCount, chunks] =
    await Promise.all([
      prisma.materialExerciseSet.findMany({
        where: { materialId, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, targetSkill: true, estimatedMinutes: true },
      }),
      prisma.vocabularyCandidate.findFirst({
        where: { materialId, reviewStatus: { in: [...PACK_CANDIDATE_REVIEW_STATUSES] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
      prisma.vocabularyCandidate.count({
        where: { materialId, reviewStatus: { in: [...PACK_CANDIDATE_REVIEW_STATUSES] } },
      }),
      prisma.extractionResult.findMany({
        where: {
          materialId,
          kind: 'SUMMARY',
          reviewStatus: { in: [...PACK_EXTRACTION_REVIEW_STATUSES] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, payloadJson: true, editedPayloadJson: true },
      }),
      prisma.extractionResult.findFirst({
        where: {
          materialId,
          kind: 'KEY_SENTENCE',
          reviewStatus: { in: [...PACK_EXTRACTION_REVIEW_STATUSES] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
      prisma.extractionResult.count({
        where: {
          materialId,
          kind: 'KEY_SENTENCE',
          reviewStatus: { in: [...PACK_EXTRACTION_REVIEW_STATUSES] },
        },
      }),
      prisma.contentChunk.findMany({
        where: { materialId, kind: { in: ['HEADING', 'MIXED'] } },
        orderBy: { seq: 'asc' },
        take: PACK_CHUNK_LIMIT,
        select: { id: true, seq: true },
      }),
    ]);

  const summary = summaryRows[0] ?? null;
  const summaryPayload = summary
    ? parseJsonObject(summary.editedPayloadJson ?? summary.payloadJson)
    : {};

  // ── 组装条目（顺序 = 建议训练顺序：先读段落 → 词汇 → 练习 → 句子） ──
  interface DraftItem {
    itemType: PackItemType;
    refId: string;
    estimatedMinutes: number;
    note: string | null;
  }
  const drafts: DraftItem[] = [];

  for (const chunk of chunks) {
    drafts.push({
      itemType: 'CHUNK',
      refId: chunk.id,
      estimatedMinutes: CHUNK_MINUTES,
      note: `先读第 ${chunk.seq} 段`,
    });
  }
  // 词汇候选聚合为**一条**复习任务：逐个候选排一条会让草案膨胀成上百条
  if (candidateFirst) {
    drafts.push({
      itemType: 'VOCAB_CANDIDATE',
      refId: candidateFirst.id,
      estimatedMinutes: VOCAB_REVIEW_MINUTES,
      note: `复习本材料的 ${candidateCount} 个已确认词汇候选`,
    });
  }
  for (const set of exerciseSets) {
    drafts.push({
      itemType: 'EXERCISE_SET',
      refId: set.id,
      estimatedMinutes: Math.max(5, set.estimatedMinutes),
      note: `${set.targetSkill} 练习：${set.title}`,
    });
  }
  if (sentenceFirst) {
    drafts.push({
      itemType: 'SENTENCE',
      refId: sentenceFirst.id,
      estimatedMinutes: Math.min(30, sentenceCount * SENTENCE_MINUTES),
      note: `精析本材料的 ${sentenceCount} 个重点句`,
    });
  }

  const estimatedMinutes = floorToFive(
    drafts.reduce((sum, item) => sum + item.estimatedMinutes, 0),
  );
  const targetSkills = uniqueInOrder([
    ...exerciseSets.map((set) => set.targetSkill),
    ...(candidateFirst ? ['VOCABULARY'] : []),
    ...(chunks.length > 0 || sentenceFirst ? ['READING'] : []),
  ]);
  const learningGoals = uniqueInOrder(toStringList(summaryPayload.learning_goals));

  const packId = await prisma.$transaction(async (tx) => {
    const pack = await tx.materialPack.upsert({
      where: { materialId },
      create: {
        materialId,
        estimatedMinutes,
        targetSkillsJson: JSON.stringify(targetSkills),
        learningGoalsJson: learningGoals.length > 0 ? JSON.stringify(learningGoals) : null,
        difficultyEstimate: material.difficultyEstimate ?? null,
        summaryId: summary?.id ?? null,
      },
      update: {
        estimatedMinutes,
        targetSkillsJson: JSON.stringify(targetSkills),
        learningGoalsJson: learningGoals.length > 0 ? JSON.stringify(learningGoals) : null,
        difficultyEstimate: material.difficultyEstimate ?? null,
        summaryId: summary?.id ?? null,
      },
      select: { id: true },
    });

    // 重建 = 清空后重写（同事务，避免中途失败留下半个包）
    await tx.materialPackItem.deleteMany({ where: { packId: pack.id } });
    if (drafts.length > 0) {
      await tx.materialPackItem.createMany({
        data: drafts.map((draft, index) => ({
          packId: pack.id,
          itemType: draft.itemType,
          refId: draft.refId,
          sortOrder: index,
          estimatedMinutes: draft.estimatedMinutes,
          note: draft.note,
        })),
      });
    }

    // 建议顺序 = 条目 id 顺序（先写后读，保证 `orderingJson` 里的 id 真实存在）
    const created = await tx.materialPackItem.findMany({
      where: { packId: pack.id },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    await tx.materialPack.update({
      where: { id: pack.id },
      data: { orderingJson: JSON.stringify(created.map((row) => row.id)) },
    });

    return pack.id;
  });

  return {
    packId,
    materialId,
    rebuilt: true,
    itemCount: drafts.length,
    estimatedMinutes,
    summaryId: summary?.id ?? null,
  };
}

/** 解析 JSON 对象；脏数据退化成空对象（一条烂 payload 不该把整包打成 500）。 */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 从自由 JSON 里取出字符串数组。
 *
 * `learning_goals` 是 AI 输出的数组（zod 在写入端已校验过一遍），但读回来的
 * payload 是**自由 JSON**（历史数据、人工编辑都可能有）,所以这里再兜一次：
 * 非字符串元素直接丢弃，而不是让 `[object Object]` 出现在学习目标里。
 */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry.trim());
  }
  return out;
}
