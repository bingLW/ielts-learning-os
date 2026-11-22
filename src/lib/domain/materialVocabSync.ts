/**
 * 「这个候选进主库还是只加来源」的**唯一裁决点**（T12 §4，纯函数无 IO）。
 *
 * 为什么必须集中成一处：同步是两个动作的合体 ——
 * ① 词库没有这个词 → 新建 `VocabularyItem` + 一条来源；
 * ② 词库已有这个词 → **只**追加 `VocabularyItemSource`，主库释义/例句一个字段都不改。
 * 如果这层判断散在 action、脚本、组件里各写一遍，迟早会出现「同步把人工润色过的
 * 释义覆盖成 AI 释义」—— 这种损坏不可逆，也没有报错。
 *
 * 规则**顺序不可调**（顺序本身就是产品语义）：
 * 1. 候选没经过人确认 → `skip`：只有人点头的词才允许进词库（G2 的延伸）。
 *    这一条必须在最前面：否则"AI 抽到就自动建词条"会绕开整个审核流程。
 * 2. 已经同步过 → `skip`：幂等，连点两次不会建出两个词条。
 * 3. 词库没有 → `create`。
 * 4. 词库已有 → `add_source`（E-04：只加来源，绝不覆盖主库内容）。
 */

/** 允许进主库的候选审核状态（必须是人做过的裁决）。 */
export const SYNC_ALLOWED_REVIEW_STATUSES = ['accepted', 'edited'] as const;

export interface SyncDecisionInput {
  /** `VocabularyCandidate.reviewStatus`（draft|accepted|edited|rejected）。 */
  candidateReviewStatus: string;
  /** `VocabularyCandidate.syncStatus`（pending|synced|skipped|failed）。 */
  syncStatus: string;
  /** 主库里同键词条（**必须**是同步时现查的结果，不能用导入时的快照）。 */
  libraryItem: { id: string; sourceCount: number } | null;
}

export interface SyncDecision {
  action: 'create' | 'add_source' | 'skip';
  /** 面向用户的一句话（写进 `syncError` 之外的展示位，或直接显示）。 */
  reasonZh: string;
}

/** 大小写/空白容错（手工 SQL 或旧数据里的 ` Accepted ` 不该被判成未审核）。 */
function normalizeStatus(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * 判定一次同步该做什么。
 *
 * @param input 见 `SyncDecisionInput`
 */
export function decideSync(input: SyncDecisionInput): SyncDecision {
  const review = normalizeStatus(input.candidateReviewStatus);

  // ① 只有人确认过的词才允许进主库
  if (!(SYNC_ALLOWED_REVIEW_STATUSES as readonly string[]).includes(review)) {
    return {
      action: 'skip',
      reasonZh: `候选尚未被采纳（当前状态：${review || '未知'}），不会写入词库`,
    };
  }

  // ② 幂等：已经同步过的不重复建词条
  if (normalizeStatus(input.syncStatus) === 'synced') {
    return { action: 'skip', reasonZh: '这条候选已经同步过，不会重复建词条' };
  }

  // ③ 词库没有 → 新建
  if (input.libraryItem === null) {
    return { action: 'create', reasonZh: '词库里还没有该词，将新建词条并记录材料来源' };
  }

  // ④ 词库已有 → 只加来源（E-04）
  const count = Number.isFinite(input.libraryItem.sourceCount)
    ? Math.max(0, Math.floor(input.libraryItem.sourceCount))
    : 0;
  return {
    action: 'add_source',
    reasonZh:
      count > 0
        ? `词库已有该词（${count} 个来源），只追加「来自材料」这一来源，不改动已有释义`
        : '词库已有该词，只追加「来自材料」这一来源，不改动已有释义',
  };
}
