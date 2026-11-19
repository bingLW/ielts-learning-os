/**
 * 由媒介学习记录生成证据的纯规则。
 *
 * 三条原则：
 * 1. 一条 `EnglishMediatedSession` 最多生成一条证据（重复生成会重复计数）；
 * 2. 证据只计入 `primarySkill` 一项技能 —— 媒介学习是跨技能应用，不是第五技能，也不拆成四项；
 * 3. 翻译依赖决定辅助级别：只有完全独立（NONE）才是 A0，其余为 A1–A3；
 *    摘要达到可检查长度（≥ 40 字）记 Standard，否则记 Quick。
 */

import { MEDIATED_SUMMARY_MIN_CHARS } from '../constants';
import type {
  AssistanceLevel,
  EvidenceLevel,
  PrimarySkill,
  TranslationDependency,
} from '../types';

export interface MediatedEvidenceSource {
  subject: string;
  topic: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  primarySkill: PrimarySkill;
  translationDependency: TranslationDependency;
  notesEn: string | null;
  summaryEn: string | null;
  questionsEn: string | null;
}

export interface MediatedEvidenceDraft {
  skill: PrimarySkill;
  evidenceType: 'APPLIED_TASK';
  level: EvidenceLevel;
  assistanceLevel: AssistanceLevel;
  outputText: string;
  prompt: string;
  materialSource: string | null;
  note: string;
}

export type MediatedEvidenceBuild =
  | { ok: true; draft: MediatedEvidenceDraft }
  | { ok: false; error: string };

export type MediatedEvidenceGate = { ok: true } | { ok: false; error: string };

/** 翻译依赖 → 辅助级别（NONE 才是 A0 独立完成）。 */
export function mediatedEvidenceAssistance(
  dependency: TranslationDependency,
): AssistanceLevel {
  switch (dependency) {
    case 'NONE':
      return 'A0';
    case 'SUBTITLE_EN':
      return 'A1';
    case 'ZH_ASSIST':
      return 'A2';
    case 'HEAVY_ZH':
      return 'A3';
    default:
      return 'A2';
  }
}

const DEPENDENCY_NOTE_ZH: Record<TranslationDependency, string> = {
  NONE: '无翻译依赖，按 A0 独立完成',
  SUBTITLE_EN: '依赖英文字幕，按 A1 记录',
  ZH_ASSIST: '需要中文辅助，按 A2 记录',
  HEAVY_ZH: '高度依赖中文，按 A3 记录',
};

/** 证据级别：摘要达到可检查长度记 Standard，否则记 Quick（不自动给 Full）。 */
export function mediatedEvidenceLevel(summaryEn: string | null): EvidenceLevel {
  return (summaryEn ?? '').trim().length >= MEDIATED_SUMMARY_MIN_CHARS ? 'STANDARD' : 'QUICK';
}

/** 正文优先取摘要，其次笔记，最后问题。 */
export function mediatedEvidenceOutput(source: MediatedEvidenceSource): string | null {
  for (const text of [source.summaryEn, source.notesEn, source.questionsEn]) {
    const trimmed = (text ?? '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** 同一条媒介记录只能有一条活动证据。 */
export function checkMediatedEvidenceUniqueness(existingCount: number): MediatedEvidenceGate {
  if (existingCount > 0) {
    return { ok: false, error: '该媒介学习记录已生成证据，不能重复生成（避免同一段学习被计两次）' };
  }
  return { ok: true };
}

/** 由媒介记录推导证据字段；无英文产出时拒绝。 */
export function buildMediatedEvidenceDraft(
  source: MediatedEvidenceSource,
): MediatedEvidenceBuild {
  const outputText = mediatedEvidenceOutput(source);
  if (!outputText) {
    return { ok: false, error: '该记录没有英文笔记/摘要/问题，不能作为可检查证据' };
  }
  if (source.primarySkill === 'FOUNDATION') {
    return { ok: false, error: '媒介学习记录缺少四技能之一的主技能，不能生成证据' };
  }

  const materialSource = [source.sourceTitle, source.sourceUrl]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' · ');

  return {
    ok: true,
    draft: {
      skill: source.primarySkill,
      evidenceType: 'APPLIED_TASK',
      level: mediatedEvidenceLevel(source.summaryEn),
      assistanceLevel: mediatedEvidenceAssistance(source.translationDependency),
      outputText,
      prompt: `${source.subject} · ${source.topic}`,
      materialSource: materialSource.length > 0 ? materialSource : null,
      note: `来自媒介学习（${source.subject} · ${source.topic}）：用英语学知识，仅计入 ${source.primarySkill} 一项技能；${DEPENDENCY_NOTE_ZH[source.translationDependency] ?? '按实际辅助情况记录'}。`,
    },
  };
}
