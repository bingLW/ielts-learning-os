/**
 * 生成题的自检闸门（§3，纯函数）。
 *
 * 一道 AI 生成的客观题在写库之前必须回答两个问题：
 * 1. **它是不是一道结构合法的题？**（硬失败 → 永远不入库）
 * 2. **答案能不能从原文依据推出来？**（一致性自检 → 只做"能证明才标 pass"）
 *
 * 为什么硬失败不能入库：材料题是"用户相信它就去练"的东西。选项重复、
 * `correctKey` 不在选项里、没有解析、没有原文依据 —— 这些错误用户一眼看不出，
 * 却会让"我做对了/做错了"这件事完全失真。宁可少几道题。
 *
 * 为什么一致性**不做启发式失败**：目前没有任何可靠方法判断"答案是否真能从这句
 * 引用推出来"（那需要真正的推理）。如果按字面匹配失败就标 `fail`，会把大量
 * 合理但换了说法的题判成坏题，用户看到满屏红色就等于学会了忽略红色。
 * 所以规则是：
 * - 引用通过回验 **且** 正确选项的文本在引用里**逐字出现** → `pass`（能证明）
 * - 其余情况 → `unchecked`（不证明、也不指控，交给人审）
 */

import { createHash } from 'node:crypto';
import type { MaterialConsistencyStatus } from '@/lib/constants';
import { normalizeForVerify, verifySourceQuote } from '@/lib/materials/sourceVerify';

/** 选项数的合法区间（D-01~D-03：三选一 / 四选一）。 */
export const EXERCISE_MIN_OPTIONS = 3;
export const EXERCISE_MAX_OPTIONS = 4;

/**
 * 可以出题的分析结果种别（§5）。
 *
 * 为什么排除 `SUMMARY` / `TOPIC` / `GRAMMAR_POINT`：
 * - 摘要/主题是**整份材料**级别的结论，没有单一 chunk 可以逐字回验，
 *   给它们出题就等于把"AI 的概括"当成"原文依据"；
 * - 语法现象在材料题里只会退化成"哪个是错的"，而错项本身也需要原文依据，
 *   本期（D-01~D-03）只做三类客观题，不引入这一类。
 */
export const EXERCISE_ANCHOR_KINDS = [
  'KEYWORD',
  'COLLOCATION',
  'KEY_SENTENCE',
  'PARAGRAPH_GIST',
] as const;
export type ExerciseAnchorKind = (typeof EXERCISE_ANCHOR_KINDS)[number];

/** 「人已经认可这段内容值得考」的两种裁决结果。 */
export const EXERCISE_ANCHOR_REVIEW_STATUSES = ['accepted', 'edited'] as const;
export type ExerciseAnchorReviewStatus = (typeof EXERCISE_ANCHOR_REVIEW_STATUSES)[number];

/** 每道题按多少分钟估算（客观单选，含回看原文的时间）。 */
export const MINUTES_PER_EXERCISE = 1.5;

/** 练习集预估时长的下限（再少也不该显示"1 分钟"）。 */
export const MIN_EXERCISE_SET_MINUTES = 5;

/**
 * 题目数 → 练习集预估时长（分钟）。
 *
 * 生成阶段与审核动作共用同一个算法：审核完一批题后，`estimatedMinutes`
 * 必须跟着变，否则「40 道题 · 5 分钟」这种矛盾会一直留在页面上。
 *
 * @param count 未退役题目数
 */
export function estimateExerciseSetMinutes(count: number): number {
  if (count <= 0) return MIN_EXERCISE_SET_MINUTES;
  return Math.max(MIN_EXERCISE_SET_MINUTES, Math.round(count * MINUTES_PER_EXERCISE));
}

/** `dedupeKey` 取 sha256 十六进制的前 16 位（D-10）。 */
export const EXERCISE_DEDUPE_KEY_LENGTH = 16;

/** 题目草稿里的单个选项。 */
export interface ExerciseOptionDraft {
  key: string;
  text: string;
}

/** 待自检的题目草稿（AI 原始输出或用户编辑后的版本）。 */
export interface ExerciseDraftInput {
  /** 题型（`MATERIAL_EXERCISE_TYPES` 中的值）。 */
  type: string;
  /** 目标技能（`MATERIAL_EXERCISE_SKILLS` 中的值）。 */
  targetSkill: string;
  subskill?: string | null;
  /** A0..C1（AI 辅助估计）。 */
  difficulty?: string | null;
  prompt: string;
  options: readonly ExerciseOptionDraft[];
  correctKey: string;
  explanation: string;
  /** 答案依据（必须逐字来自 `chunkText`）。 */
  evidenceQuote: string;
  /** 依据所属 chunk 的 id（去重键的一部分）。 */
  chunkId: string;
  /** 该 chunk 的正文；`null` 表示找不到这个 chunk（引用无从核验）。 */
  chunkText: string | null;
}

/** 硬失败的机器码（调用方据此决定返回 `VALIDATION` 还是 `PRECONDITION`）。 */
export type ExerciseCheckFailureCode =
  | 'OPTION_COUNT'
  | 'OPTION_KEY_EMPTY'
  | 'OPTION_KEY_DUPLICATE'
  | 'OPTION_TEXT_EMPTY'
  | 'CORRECT_KEY_MISSING'
  | 'PROMPT_EMPTY'
  | 'EXPLANATION_EMPTY'
  | 'QUOTE_EMPTY'
  | 'UNKNOWN_CHUNK'
  | 'QUOTE_UNVERIFIABLE';

/** 一条硬失败（码 + 人话，UI 直接显示 `messageZh`）。 */
export interface ExerciseCheckFailure {
  code: ExerciseCheckFailureCode;
  messageZh: string;
}

/** 落库用的答案负载（`GeneratedExercise.answerJson`）。 */
export interface ExerciseAnswerPayload {
  options: ExerciseOptionDraft[];
  correctKey: string;
  /** 本期只有单选（D-01~D-03 全是客观单选题）。 */
  isSingleAnswer: true;
}

/** 自检通过的结果。 */
export interface ExerciseCheckSuccess {
  ok: true;
  answer: ExerciseAnswerPayload;
  answerJson: string;
  consistencyCheck: MaterialConsistencyStatus;
  consistencyNote: string | null;
  dedupeKey: string;
}

/** 自检失败的结果。 */
export interface ExerciseCheckFailureResult {
  ok: false;
  failures: ExerciseCheckFailure[];
}

export type ExerciseCheckResult = ExerciseCheckSuccess | ExerciseCheckFailureResult;

/** 失败码里哪些属于"依据/引用"问题（Action 层映射成 `PRECONDITION`）。 */
const QUOTE_RELATED_CODES: readonly ExerciseCheckFailureCode[] = [
  'QUOTE_EMPTY',
  'UNKNOWN_CHUNK',
  'QUOTE_UNVERIFIABLE',
];

/**
 * 失败集合里是否包含「依据类」问题。
 *
 * 为什么要把它们单独拎出来：其余失败是"用户填错了"（`VALIDATION`），
 * 而依据类失败意味着**这道题的证据没了**（chunk 被删、原文被改、AI 编了引用），
 * 用户怎么改也改不好，必须换一条回归原文的路 —— 所以返回 `PRECONDITION`。
 *
 * @param failures 自检失败列表
 */
export function hasQuoteFailure(failures: readonly ExerciseCheckFailure[]): boolean {
  return failures.some((failure) => QUOTE_RELATED_CODES.includes(failure.code));
}

/**
 * 计算去重键：`sha256(type|prompt|answerJson|chunkId)` 前 16 位（D-10）。
 *
 * 为什么把 `chunkId` 也算进去：同一道题干出现在不同段落时，它们是两道题
 * （依据不同、回查落点不同），不该被当成重复丢掉。
 *
 * @param type 题型
 * @param prompt 题干
 * @param answerJson 答案负载的规范 JSON
 * @param chunkId 依据所属 chunk
 */
export function computeExerciseDedupeKey(
  type: string,
  prompt: string,
  answerJson: string,
  chunkId: string,
): string {
  return createHash('sha256')
    .update(`${type}|${prompt}|${answerJson}|${chunkId}`)
    .digest('hex')
    .slice(0, EXERCISE_DEDUPE_KEY_LENGTH);
}

/**
 * 对一道题做完整自检。
 *
 * 顺序刻意固定：先结构、再依据、最后一致性 —— 这样返回的 `failures` 里
 * 第一条永远是最该先修的（结构错了就没必要再谈引用）。
 *
 * @param draft 题目草稿
 */
export function checkExerciseDraft(draft: ExerciseDraftInput): ExerciseCheckResult {
  const failures: ExerciseCheckFailure[] = [];

  const prompt = draft.prompt.trim();
  const explanation = draft.explanation.trim();
  const quote = draft.evidenceQuote.trim();
  const options = draft.options.map((option) => ({
    key: option.key.trim(),
    text: option.text.trim(),
  }));
  const correctKey = draft.correctKey.trim();

  // ── ① 结构 ────────────────────────────────────────────────────────────
  if (
    options.length < EXERCISE_MIN_OPTIONS
    || options.length > EXERCISE_MAX_OPTIONS
  ) {
    failures.push({
      code: 'OPTION_COUNT',
      messageZh: `选项数必须是 ${EXERCISE_MIN_OPTIONS}–${EXERCISE_MAX_OPTIONS} 个（当前 ${options.length} 个）`,
    });
  }

  if (options.some((option) => option.key.length === 0)) {
    failures.push({ code: 'OPTION_KEY_EMPTY', messageZh: '每个选项都必须有标号（A/B/C/D）' });
  }

  const keys = options.map((option) => option.key).filter((key) => key.length > 0);
  if (new Set(keys).size !== keys.length) {
    failures.push({ code: 'OPTION_KEY_DUPLICATE', messageZh: '选项标号不能重复' });
  }

  if (options.some((option) => option.text.length === 0)) {
    failures.push({ code: 'OPTION_TEXT_EMPTY', messageZh: '每个选项都必须有内容' });
  }

  if (correctKey.length === 0 || !keys.includes(correctKey)) {
    failures.push({
      code: 'CORRECT_KEY_MISSING',
      messageZh: '正确答案必须是选项中的某一个（否则这道题永远做不对）',
    });
  }

  if (prompt.length === 0) {
    failures.push({ code: 'PROMPT_EMPTY', messageZh: '题干不能为空' });
  }

  if (explanation.length === 0) {
    failures.push({ code: 'EXPLANATION_EMPTY', messageZh: '必须给出解析（为什么这是答案）' });
  }

  if (quote.length === 0) {
    failures.push({ code: 'QUOTE_EMPTY', messageZh: '必须给出原文依据，否则这道题不可核验' });
  }

  // ── ② 依据回验（ADR-04 L4） ────────────────────────────────────────────
  if (quote.length > 0) {
    if (draft.chunkText === null) {
      failures.push({
        code: 'UNKNOWN_CHUNK',
        messageZh: '这道题声称的依据所在段落不存在（可能段落已被删除或原文已重新解析）',
      });
    } else {
      const verified = verifySourceQuote(quote, draft.chunkText);
      if (!verified.verified) {
        failures.push({
          code: 'QUOTE_UNVERIFIABLE',
          messageZh:
            verified.reason === 'too_short'
              ? '原文依据太短，无法核验（至少需要 8 个字符）'
              : '原文依据无法在所属段落里逐字找到（可能是改写、翻译或凭空生成）',
        });
      }
    }
  }

  // 任何硬失败都到此为止：不入库，也不再谈一致性
  if (failures.length > 0) return { ok: false, failures };

  // ── ③ 一致性自检（只标记，不做启发式失败） ─────────────────────────────
  const answer: ExerciseAnswerPayload = { options, correctKey, isSingleAnswer: true };
  const answerJson = JSON.stringify(answer);

  const correctOption = options.find((option) => option.key === correctKey);
  const quoteNorm = normalizeForVerify(quote);
  const correctNorm = correctOption ? normalizeForVerify(correctOption.text) : '';
  const answerAppearsInQuote = correctNorm.length > 0 && quoteNorm.includes(correctNorm);

  return {
    ok: true,
    answer,
    answerJson,
    consistencyCheck: answerAppearsInQuote ? 'pass' : 'unchecked',
    consistencyNote: answerAppearsInQuote
      ? '正确答案的文本在原文依据中逐字出现，可确认答案有依据支撑'
      : '无法自动核对「答案能否由这段依据推出」（需要人工判断）；这不代表题目有问题',
    dedupeKey: computeExerciseDedupeKey(draft.type, prompt, answerJson, draft.chunkId),
  };
}
