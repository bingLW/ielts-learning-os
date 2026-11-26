/**
 * 候选队列：按「资格 → 优先级 → 分数 → 身份键」排好序的原样展示。
 *
 * 预计分钟在这里是**候选口径**（`TaskCandidate.estMinutes`），只用于挑任务，
 * 不是计划分钟 —— 计划分钟只来自 `PlanTask.plannedMinutes`（I-2）。
 */

import { ELIGIBILITY_LABEL_ZH } from '@/lib/constants';
import type { CandidateRowDto } from '@/lib/queries/planner';
import { DecisionTrace } from './DecisionTrace';
import { PromoteCandidateButton } from './PromoteCandidateButton';

function EligibilityTag({ code }: { code: string }) {
  const blocked = code !== 'ELIGIBLE';
  return (
    <span
      className={[
        'rounded px-1 text-[10px]',
        blocked ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700',
      ].join(' ')}
    >
      {ELIGIBILITY_LABEL_ZH[code] ?? code}
    </span>
  );
}

export function CandidateTable({ rows }: { rows: CandidateRowDto[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-inkMuted">该筛选条件下没有候选。</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {rows.map((row) => (
        <li key={row.id} data-candidate={row.candidateKey} className="px-2.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-9 shrink-0 font-semibold text-ink">{row.decision?.priority ?? '—'}</span>
            <span className="min-w-0 flex-1 truncate text-ink" title={row.title}>
              {row.title}
            </span>
            <span className="text-[11px] text-inkMuted">{row.moduleLabel}</span>
            <span className="text-[11px] text-inkMuted">{row.targetSkill}</span>
            <span className="tabular text-[11px] text-inkMuted">
              预计 {row.estimate ? `${row.estimate.minMinutes}–${row.estimate.maxMinutes}` : row.estMinutes} 分钟
              {row.estimate?.basis === 'CALIBRATED' ? ` · 历史校准 ${row.estimate.sampleCount} 样本` : ' · 估计'}
            </span>
            {row.decision && <EligibilityTag code={row.decision.eligibility} />}
            {row.isAiSuggested && <span className="rounded bg-violet-50 px-1 text-[10px] text-violet-700">AI 建议</span>}
            {row.decision && row.decision.priority !== 'P0' && (
              <PromoteCandidateButton candidateId={row.id} priority={row.decision.priority} />
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-inkMuted">
            {row.sourceLabel}
            {row.sourceRef ? ` · ${row.sourceRef}` : ''}
            {row.decision ? ` · 分数 ${row.decision.score.toFixed(4)}` : ''}
            {row.minMinutes !== row.estMinutes ? ` · 可拆到 ${row.minMinutes} 分钟` : ''}
            {row.estimate ? ` · 模型 ${row.estimate.modelVersion} / 规则 ${row.estimate.ruleVersion}` : ''}
            {row.question
              ? ` · 阶段元数据 ${row.question.targetLevelMin ?? '—'}–${row.question.targetLevelMax ?? row.question.difficultyEstimate ?? '—'}（无权威阶段门槛）`
              : ''}
            {row.mistake
              ? row.mistake.status === 'ATTRIBUTED'
                ? ` · 错题归属学习记录 ${row.mistake.studyRecordId?.slice(0, 10)} / ${row.mistake.skill ?? '未知技能'}`
                : ' · 错题未归属学习记录（技能归 META）'
              : ''}
            {row.decision?.blockedReason ? ` · ${row.decision.blockedReason}` : ''}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-brand">展开决策轨迹</summary>
            <div className="mt-1 rounded-md bg-surfaceAlt p-2">
              <DecisionTrace row={row} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}