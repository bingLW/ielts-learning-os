/**
 * EGIU 三色判定 —— 纯函数，零 IO，时间不参与。
 *
 * 分支顺序**不可调换**（PRD §6.1 边界约定 4）：
 *   负数输入校验 → `correct > total` 脏数据校验 → total=0 判 PENDING → 硬否决 RED
 *   → 题量充足(≥5)正确率档 → 题量少(1..4)降权档
 *
 * 注意：`correct > total` 必须早于 `total === 0`，否则 `{total: 0, correct: 3}`
 * 这类脏数据会被当成「无数据」静默判 PENDING（缺陷 D1）。
 *
 * 这里是全站唯一的判定实现：UI 不允许自己重算颜色，必须展示服务端返回的 `reason`。
 */

import {
  FULL_VOLUME_MIN_QUESTIONS,
  GREEN_ACC,
  LOW_VOLUME_MIN_SENTENCES,
  LOW_VOLUME_PASS,
  LOW_VOLUME_SENTENCE_HALF,
  LOW_VOLUME_W,
  YELLOW_ACC,
} from '../constants';
import type { DomainError, EgiuJudgeInput, EgiuJudgment } from '../types';

/** 判定失败码。 */
export type EgiuJudgeErrorCode = 'CORRECT_GT_TOTAL' | 'NEGATIVE_INPUT';

/** 判定结果（成功 / 失败均可序列化）。 */
export type EgiuJudgeResult =
  | { ok: true; judgment: EgiuJudgment }
  | DomainError<EgiuJudgeErrorCode>;

/** 分数文案：最多 3 位小数，去掉无意义的尾零（`1` 而不是 `1.000`）。 */
function scoreText(score: number): string {
  return String(Number(score.toFixed(3)));
}

/**
 * 按 PRD §6.1 伪代码逐条判定。
 *
 * @param input total / correct / explainOK / sentences / coreRuleOK
 * @returns 命中分支与中文理由；输入非法时返回失败码（不抛异常）
 */
export function judgeEgiuColor(input: EgiuJudgeInput): EgiuJudgeResult {
  const { total, correct, explainOK, sentences, coreRuleOK } = input;

  // ① 输入校验：负数一律视为非法输入（含 correct<0 / sentences<0）
  if (total < 0 || correct < 0 || sentences < 0) {
    return { ok: false, code: 'NEGATIVE_INPUT' };
  }

  // ② 输入校验：`correct > total` 是脏数据，必须先于 `total === 0` 判定，
  //    否则 `{total: 0, correct: 3}` 会被静默判成 PENDING（缺陷 D1）。
  if (correct > total) {
    return { ok: false, code: 'CORRECT_GT_TOTAL' };
  }

  // ③ 数据不足：不判定、不排程
  if (total === 0) {
    return {
      ok: true,
      judgment: {
        color: 'PENDING',
        reason: '题量为 0，不判定，不生成复习计划',
        branch: 'ZERO',
      },
    };
  }

  const acc = correct / total;

  // ④ 硬否决：不理解核心规则 → 红灯，与正确率无关
  if (!coreRuleOK) {
    return {
      ok: true,
      judgment: {
        color: 'RED',
        reason: '不理解核心规则（硬否决）',
        branch: 'OVERRIDE',
      },
    };
  }

  // ⑤ 题量充足：正确率可信，按 SOP 三色表直接映射
  if (total >= FULL_VOLUME_MIN_QUESTIONS) {
    if (acc >= GREEN_ACC && explainOK && sentences >= LOW_VOLUME_MIN_SENTENCES) {
      return {
        ok: true,
        judgment: {
          color: 'GREEN',
          reason: '正确率≥90% + 能说规则 + 造句≥2',
          branch: 'FULL',
        },
      };
    }
    if (acc >= GREEN_ACC) {
      return {
        ok: true,
        judgment: {
          color: 'YELLOW',
          reason: '答案对但解释不清/造句不足（SOP：答案对但解释不清=黄灯）',
          branch: 'FULL',
        },
      };
    }
    if (acc >= YELLOW_ACC) {
      return {
        ok: true,
        judgment: {
          color: 'YELLOW',
          reason: '正确率 70%–89%',
          branch: 'FULL',
        },
      };
    }
    return {
      ok: true,
      judgment: {
        color: 'RED',
        reason: '正确率 <70%',
        branch: 'FULL',
      },
    };
  }

  // ⑥ 题量过少（1..4）：正确率降权 30%，解释 40% + 造句 30%
  const accScore = acc * LOW_VOLUME_W.ACC;
  const explScore = explainOK ? LOW_VOLUME_W.EXPLAIN : 0;
  const sentScore =
    sentences >= LOW_VOLUME_MIN_SENTENCES
      ? LOW_VOLUME_W.SENTENCE
      : sentences === 1
        ? LOW_VOLUME_SENTENCE_HALF
        : 0;
  const score = accScore + explScore + sentScore;

  if (explainOK && sentences >= LOW_VOLUME_MIN_SENTENCES && score >= LOW_VOLUME_PASS) {
    return {
      ok: true,
      judgment: {
        color: 'GREEN',
        reason: `题量少但解释+造句双达标且综合分≥0.85（S=${scoreText(score)}）`,
        branch: 'LOW_VOLUME',
        score,
      },
    };
  }

  if (explainOK || sentences >= LOW_VOLUME_MIN_SENTENCES) {
    return {
      ok: true,
      judgment: {
        color: 'YELLOW',
        reason: `题量少，证据不全，需补测（S=${scoreText(score)}）`,
        branch: 'LOW_VOLUME',
        score,
      },
    };
  }

  return {
    ok: true,
    judgment: {
      color: 'RED',
      reason: `题量少且解释/造句均不达标（S=${scoreText(score)}）`,
      branch: 'LOW_VOLUME',
      score,
    },
  };
}

/**
 * 题量不足是否要追加「补测」。
 *
 * PRD Q2：判 YELLOW 且 total<5 时自动追加一个 +2 天的 MANUAL 档补测点。
 */
export function needsLowVolumeRetest(color: string, totalQuestions: number): boolean {
  return color === 'YELLOW' && totalQuestions < FULL_VOLUME_MIN_QUESTIONS;
}
