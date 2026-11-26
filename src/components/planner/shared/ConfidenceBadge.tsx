/**
 * 置信度徽章。低置信度**只用虚线边框 + 「待确认」**，不得用红色 ——
 * 「证据少」不是「能力差」，两者用不同视觉语言。
 */

import { EVIDENCE_CONFIDENCE_LABEL_ZH } from '@/lib/constants';
import type { EvidenceConfidence } from '@/lib/types';

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const level = (confidence in EVIDENCE_CONFIDENCE_LABEL_ZH
    ? confidence
    : 'LOW') as EvidenceConfidence;
  const isLow = level === 'LOW';
  return (
    <span
      title={`confidence=${level}`}
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        isLow
          ? 'border-dashed border-slate-400 bg-white text-slate-600'
          : 'border-line bg-surfaceAlt text-ink',
      ].join(' ')}
    >
      置信度 {EVIDENCE_CONFIDENCE_LABEL_ZH[level]}
      {isLow && <span className="text-[10px] text-inkMuted">· 待确认</span>}
    </span>
  );
}