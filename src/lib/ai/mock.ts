/**
 * 内置 Mock Provider 的结构化输出。
 *
 * 目的：在没有任何外部 API Key 时也能跑通完整教学闭环，
 * 且输出确定、可测试。所有文案都明确标注「模拟」，不冒充真实模型结论。
 */

import {
  AI_ERROR_CATEGORY_LABEL_ZH,
  type AiErrorCategory,
} from '@/lib/constants';
import { excerpt } from './privacy';
import type { StructuredByKind } from './structured';
import type { AiPromptKind, AiPromptMeta } from './types';

/** 32 位 FNV-1a，用于生成稳定的 task_id。 */
function stableId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const MINUTES_BY_SKILL: Record<string, number> = {
  WRITING: 20,
  SPEAKING: 12,
  LISTENING: 15,
  READING: 15,
  GRAMMAR: 10,
  VOCABULARY: 10,
  INTEGRATED: 20,
};

const CATEGORY_BY_SKILL: Record<string, AiErrorCategory> = {
  GRAMMAR: 'KNOWLEDGE_GAP',
  VOCABULARY: 'RETRIEVAL_FAILURE',
  WRITING: 'STRATEGY',
  LISTENING: 'ATTENTION',
  READING: 'ATTENTION',
  SPEAKING: 'TASK_MISUNDERSTANDING',
  INTEGRATED: 'STRATEGY',
};

function isBeginner(level: string): boolean {
  return level.startsWith('A0') || level.startsWith('A1');
}

function buildTask(meta: AiPromptMeta): StructuredByKind['task'] {
  const beginner = isBeginner(meta.targetLevel);
  const minutes = MINUTES_BY_SKILL[meta.skill] ?? 10;
  return {
    task_id: `mock-${stableId(`${meta.skill}|${meta.objective}|${meta.targetLevel}`)}`,
    skill: meta.skill,
    target_level: meta.targetLevel,
    objective: meta.objective,
    instructions: beginner
      ? `用简单的句子完成这个任务：${meta.objective}。先自己写，不要查翻译。写 2–3 句就可以，允许用中文标注不确定的地方。`
      : `Complete this task independently: ${meta.objective}. Write 4–6 sentences. Do not use translation tools; note any uncertainty in your own words.`,
    estimated_minutes: minutes,
    allowed_aids: [],
    rubric: [
      {
        criterion: '任务回应',
        description: '是否回应了任务目标，而不是写无关内容',
      },
      {
        criterion: '语言准确',
        description: beginner ? '基本句型正确即可' : '语法与时态基本正确，表达可理解',
      },
    ],
    source_refs: ['模拟任务（未调用外部模型）'],
  };
}

function buildDiagnosis(meta: AiPromptMeta): StructuredByKind['diagnosis'] {
  const baseline = meta.baseline?.trim() ?? '';
  const quote = baseline.length > 0 ? excerpt(baseline, 60) : '';
  const category = CATEGORY_BY_SKILL[meta.skill] ?? 'KNOWLEDGE_GAP';
  const label = AI_ERROR_CATEGORY_LABEL_ZH[category];
  const evidence = quote
    ? [{ quote, location: '用户基线作答开头' }]
    : [{ quote: '', location: '未提交作答' }];
  return {
    summary: quote
      ? `模拟诊断：作答「${quote}」整体可理解，但在「${meta.objective}」上存在一处可操作的改进点（${label}）。`
      : '证据不足：用户尚未提交作答，无法给出基于证据的诊断。',
    observed_evidence: evidence,
    error_categories: quote ? [category] : [],
    hypotheses: quote
      ? [
          {
            cause: `可能与「${label}」相关：对目标结构还不够熟悉，输出时依赖直觉。`,
            confidence: 'MEDIUM',
            basis: `引用作答片段：${quote}`,
          },
        ]
      : [],
    confirmed_vs_uncertain: quote
      ? '已确认：作答存在可指出的具体位置；未确认：是否长期存在，需要独立复测再判断。'
      : '当前只有「作答为空」这一确定事实，其余均不确定。',
    strengths: quote ? ['已按要求先独立作答，没有依赖提示'] : ['愿意开始任务'],
    priority_issues: quote ? [`优先修复：${label}（引用位置见 observed_evidence）`] : ['先完成一次独立作答'],
    recommended_next_step: quote
      ? '先尝试 1 级提示，自己修改一处后再复测。'
      : '先保存一份独立作答，再进入诊断。',
  };
}

function buildHint(meta: AiPromptMeta): StructuredByKind['hint'] {
  const level = Math.min(3, Math.max(1, meta.hintLevel ?? 1));
  const category = CATEGORY_BY_SKILL[meta.skill] ?? 'KNOWLEDGE_GAP';
  if (level === 1) {
    return {
      hint_level: 1,
      hint_text: `回到任务目标：「${meta.objective}」。圈出题干里的关键词，检查你的答案是否逐项回应。先不要重写整段。`,
      reveals_answer: false,
      related_rule: '先确认任务要求，再检查内容覆盖',
      next_question: '你的答案回应了题目里的哪些关键词？',
    };
  }
  if (level === 2) {
    return {
      hint_level: 2,
      hint_text: `聚焦一处：${AI_ERROR_CATEGORY_LABEL_ZH[category]}。只修改与它相关的那一个句子，改完朗读一遍，确认意思没有变。`,
      reveals_answer: false,
      related_rule: `${AI_ERROR_CATEGORY_LABEL_ZH[category]}：先定位，再小步修改`,
      next_question: '你准备修改哪一句？改前和改后分别是什么？',
    };
  }
  return {
    hint_level: 3,
    hint_text: `完整思路：先用简单句写出主干（谁 + 做什么 + 结果），再补充时间、原因等细节；最后检查主谓一致和时态。示例：把长句拆成两句短句，意思保持不变。`,
    reveals_answer: true,
    related_rule: '先主干后细节；拆句优先于堆叠从句',
    next_question: '按这个思路重写一遍，再和原句对比。',
  };
}

function buildTeaching(meta: AiPromptMeta): StructuredByKind['teaching'] {
  const quote = meta.baseline?.trim() ? excerpt(meta.baseline, 50) : '（未提交作答）';
  return {
    what_went_well: [quote === '（未提交作答）' ? '愿意进入讲解模式' : '已独立产出内容，便于定位问题'],
    what_to_improve: [`围绕「${meta.objective}」让表达更直接、更短`],
    specific_corrections: [
      {
        original: quote,
        corrected: quote === '（未提交作答）' ? '（先写一句最简单的版本）' : `示例改法：把「${quote}」拆成两句短句，先写主干再补细节。`,
        reason: '拆句能降低语法负担，先保证意思清楚，再追求复杂表达。',
      },
    ],
    explanation: isBeginner(meta.targetLevel)
      ? `简单说：一次只做一件事。先写「谁做什么」，再加「什么时候 / 为什么」。这属于受辅助讲解，不算独立证据。`
      : `Keep one main clause per sentence first; add subordinate ideas only after the main meaning is clear. This explanation is assisted practice, not independent evidence.`,
    practice_recommendations: ['用同一目标写 2 个新句子，不照抄示例', '完成后做一次不看提示的独立复测'],
    limitations: '这是规则引擎模拟讲解，未调用外部模型；真实语言判断请结合教师或词典核对。',
  };
}

function buildDrill(meta: AiPromptMeta): StructuredByKind['drill'] {
  const base = meta.objective;
  return {
    title: `针对「${base}」的变式练习`,
    objective: base,
    items: [
      {
        prompt: `变式 1：换一个生活场景，用 2 句话完成「${base}」。`,
        answer: '（参考：先写主干句，再补一个细节句，确保两句都回应目标。）',
        explanation: '变式 1 检查能否迁移到新场景，而不是重复原题。',
        difficulty: 'EASY',
      },
      {
        prompt: `变式 2：把变式 1 的两句话合并成一句，意思保持不变。`,
        answer: '（参考：用 because / when 等连接词合并，保持主谓一致。）',
        explanation: '变式 2 检查句子合并时的语法控制。',
        difficulty: 'MEDIUM',
      },
      {
        prompt: `变式 3：写一个反例，说明什么写法不符合「${base}」的要求。`,
        answer: '（参考：指出反例中缺失的关键信息或错误结构。）',
        explanation: '变式 3 检查对规则边界的理解，防止只会模仿。',
        difficulty: 'HARD',
      },
    ],
    estimated_minutes: 12,
  };
}

function buildAssessment(meta: AiPromptMeta): StructuredByKind['assessment'] {
  const performanceType = meta.performanceType ?? 'immediate_retest';
  const aidLevel = meta.aidLevel ?? 'none';
  const independent = aidLevel === 'none';
  return {
    performance_type: performanceType as StructuredByKind['assessment']['performance_type'],
    aid_level: aidLevel as StructuredByKind['assessment']['aid_level'],
    rubric_scores: [
      {
        criterion: '任务回应',
        score: meta.retestAnswer?.trim() ? 1 : 0,
        comment: meta.retestAnswer?.trim() ? '已作答，具体质量需人工复核' : '未提交复测作答',
      },
      {
        criterion: '语言准确',
        score: independent && meta.retestAnswer?.trim() ? 1 : 0,
        comment: independent ? '无辅助场景，按最低标准保守评分' : '存在辅助，不计入独立证据',
      },
    ],
    evidence_refs: meta.retestQuestion ? [meta.retestQuestion.slice(0, 120)] : [],
    confidence: 'MEDIUM',
    is_official_score: false,
    limitations: '模拟 AI 辅助评估，仅供练习反馈，不是官方 IELTS 分数或 CEFR 认证。',
  };
}

function buildReviewer(meta: AiPromptMeta): StructuredByKind['reviewer'] {
  const quote = meta.baseline?.trim() ? excerpt(meta.baseline, 40) : '（无基线记录）';
  const category = CATEGORY_BY_SKILL[meta.skill] ?? 'KNOWLEDGE_GAP';
  return {
    summary: `模拟复盘：基线「${quote}」显示的主要问题集中在${AI_ERROR_CATEGORY_LABEL_ZH[category]}。是否改善要以本次不看提示的平行任务为准。`,
    comparison: {
      improved: meta.retestAnswer?.trim() ? ['已完成平行复测，具备可比对的新样本'] : ['尚无新样本，暂不能判断改善'],
      still_weak: [`${AI_ERROR_CATEGORY_LABEL_ZH[category]}仍需在延迟复测中验证`],
    },
    retest_task: {
      instructions: `换一个主题，独立完成「${meta.objective}」的平行任务；不使用词典、翻译或 AI 提示，限时 10 分钟。`,
      estimated_minutes: 10,
    },
    next_step: '先完成独立复测；若结果稳定，再进入 7 天延迟复测。',
    confidence: 'MEDIUM',
  };
}

function mockLevelByLength(words: number): StructuredByKind['diag_writing']['estimated_level'] {
  if (words < 5) return 'Pre-A1';
  if (words < 12) return 'A1';
  if (words < 30) return 'A2';
  if (words < 60) return 'B1';
  return 'B2';
}

function buildDiagEvaluation(
  meta: AiPromptMeta,
  kind: 'diag_speaking' | 'diag_writing',
): StructuredByKind['diag_writing'] {
  const answer = (meta.learnerAnswer ?? '').trim();
  const words = answer ? answer.split(/\s+/).length : 0;
  const level = mockLevelByLength(words);
  const criteria =
    kind === 'diag_speaking'
      ? ['流利与连续性', '词汇范围', '语法范围与准确性', '可理解度', '连贯性']
      : ['任务完成度', '语法范围与准确性', '词汇资源', '连贯与衔接', '拼写与标点'];
  const score = words >= 40 ? 2 : words >= 12 ? 1 : 0;
  return {
    estimated_level: level,
    level_range: words >= 12 ? [level, level] : ['Pre-A1', level],
    dimensions: criteria.map((criterion) => ({
      criterion,
      score,
      evidence: answer ? excerpt(answer, 60) : '（未提交作答）',
      comment: '模拟评估：仅按样本长度给出保守评分，具体质量需人工复核',
    })),
    strengths: answer ? ['已提交可分析的原始作答'] : [],
    issues: answer ? [] : ['缺少作答，暂不能判断'],
    confidence: words >= 30 ? 'MEDIUM' : 'LOW',
    limitations:
      '这是内置模拟评估，未调用外部模型；不代表官方 CEFR 或 IELTS 结果，ASR 文本不能单独用于发音判断。',
    needs_follow_up: words < 30,
  };
}

export function buildMockPayload<K extends AiPromptKind>(
  kind: K,
  meta: AiPromptMeta,
): StructuredByKind[K] {
  switch (kind) {
    case 'task':
      return buildTask(meta) as StructuredByKind[K];
    case 'diagnosis':
      return buildDiagnosis(meta) as StructuredByKind[K];
    case 'hint':
      return buildHint(meta) as StructuredByKind[K];
    case 'teaching':
      return buildTeaching(meta) as StructuredByKind[K];
    case 'drill':
      return buildDrill(meta) as StructuredByKind[K];
    case 'assessment':
      return buildAssessment(meta) as StructuredByKind[K];
    case 'reviewer':
      return buildReviewer(meta) as StructuredByKind[K];
    case 'diag_routing':
      return {
        next_skill: meta.skill,
        next_difficulty: 2,
        rationale: '模拟路由：使用确定性规则，答对升档、答错降档。',
        stop_reason: '样本已达本轮上限',
      } as StructuredByKind[K];
    case 'diag_speaking':
      return buildDiagEvaluation(meta, 'diag_speaking') as StructuredByKind[K];
    case 'diag_writing':
      return buildDiagEvaluation(meta, 'diag_writing') as StructuredByKind[K];
    case 'diag_error':
      return {
        categories: meta.learnerAnswer?.trim() ? ['RETRIEVAL_FAILURE'] : [],
        evidence: meta.learnerAnswer?.trim() ? [excerpt(meta.learnerAnswer, 60)] : [],
        confidence: 'LOW',
      } as StructuredByKind[K];
    case 'diag_summary':
      return {
        summary: `模拟汇总：当前画像来自诊断作答，等级为 AI 辅助估计，不是官方认证。`,
        strengths: [],
        gaps: ['需要更多样本才能稳定判断'],
        suggestions: ['完成补测'],
        confidence: 'LOW',
        limitations: '内置模拟汇总，未调用外部模型。',
      } as unknown as StructuredByKind[K];
    case 'diag_plan':
      return {
        rationale: '模拟计划：依据每周预算生成，等待用户确认。',
        phases: [
          { window: '7D', focus: '启动', tasks: [{ title: '基础诊断补测', minutes: 20 }] },
          { window: '30D', focus: '建立习惯', tasks: [{ title: '四项技能轮换', minutes: 30 }] },
          { window: '90D', focus: '阶段验收', tasks: [{ title: '延迟复测', minutes: 30 }] },
        ],
      } as unknown as StructuredByKind[K];
    default:
      throw new Error(`未知提示词种类：${String(kind)}`);
  }
}