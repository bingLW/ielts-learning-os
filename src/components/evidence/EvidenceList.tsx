'use client';

/**
 * 证据列表：一行一条证据，点击展开条件/评分/附件/链关系。
 *
 * 刻意保留「辅助版」的醒目标记：辅助产出不能和独立产出混在一起看。
 */

import { useState } from 'react';
import {
  ASSISTANCE_LEVEL_LABEL_ZH,
  ASSESSOR_TYPE_LABEL_ZH,
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_LEVEL_LABEL_ZH,
  EVIDENCE_PRIVACY_LABEL_ZH,
  EVIDENCE_SCORE_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { nextChainType } from '@/lib/domain/evidence';
import type { EvidenceDetailDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export interface EvidenceListProps {
  rows: EvidenceDetailDto[];
  onDerive: (row: EvidenceDetailDto) => void;
  onArchive: (row: EvidenceDetailDto) => void;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function typeBadgeClass(row: EvidenceDetailDto): string {
  if (row.evidenceType === 'BASELINE') return 'bg-slate-100 text-slate-700';
  if (row.evidenceType === 'ASSISTED') return 'bg-amber-50 text-amber-800';
  if (row.evidenceType === 'TRANSFER') return 'bg-violet-50 text-violet-700';
  return 'bg-blue-50 text-blue-700';
}

export function EvidenceList({ rows, onDerive, onArchive }: EvidenceListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => {
        const expanded = expandedId === row.id;
        const next = nextChainType(row.evidenceType);
        const archived = row.archivedAt !== null;
        return (
          <li key={row.id} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : row.id)}
                aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="text-[11px] text-inkMuted">
                  {LEARNING_EVIDENCE_TYPE_CODE[row.evidenceType]}
                </span>
                <span
                  className={[
                    'rounded px-1.5 py-0.5 text-[11px] font-medium',
                    typeBadgeClass(row),
                  ].join(' ')}
                >
                  {LEARNING_EVIDENCE_TYPE_LABEL_ZH[row.evidenceType]}
                </span>
                <span className="text-xs font-medium text-ink">
                  {EVIDENCE_SKILL_LABEL_ZH[row.skill]}
                </span>
                <span className="rounded bg-surfaceAlt px-1.5 py-0.5 text-[10px] text-inkMuted">
                  {EVIDENCE_LEVEL_LABEL_ZH[row.level]}
                </span>
                <span
                  className={[
                    'rounded px-1.5 py-0.5 text-[10px]',
                    row.independent ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800',
                  ].join(' ')}
                  title={row.independent ? 'A0 无辅助，可计入独立表现' : '有辅助：不计为独立表现'}
                >
                  {row.independent ? '独立' : '辅助'}
                </span>
                {row.score !== null && (
                  <span className="rounded border border-line px-1.5 py-0.5 text-[10px] tabular text-inkMuted">
                    评分 {row.score}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-inkMuted">
                  {row.outputPreview ?? (row.hasArtifact ? '（仅附件）' : '（无正文）')}
                </span>
                {row.childCount > 0 && (
                  <span
                    className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
                    title="该证据之后还有版本"
                  >
                    +{row.childCount}
                  </span>
                )}
                {archived && (
                  <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">
                    已归档
                  </span>
                )}
                <Icon name={expanded ? 'up' : 'down'} size={13} className="shrink-0 text-inkMuted" />
              </button>
              <span className="shrink-0 text-[11px] tabular text-inkMuted">
                {formatDateTime(row.createdAt)}
              </span>
              {!archived && (
                <div className="flex shrink-0 gap-1">
                  {next && (
                    <Button variant="secondary" size="sm" onClick={() => onDerive(row)}>
                      <Icon name="plus" size={12} />
                      派生 {LEARNING_EVIDENCE_TYPE_CODE[next]}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onArchive(row)}>
                    <Icon name="trash" size={12} />
                    归档
                  </Button>
                </div>
              )}
            </div>

            {expanded && (
              <div className="mt-2 rounded-md border border-line bg-surfaceAlt p-2.5 text-[11px] text-ink">
                <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  <p>
                    <span className="text-inkMuted">辅助级别：</span>
                    {ASSISTANCE_LEVEL_LABEL_ZH[row.assistanceLevel]}
                  </p>
                  <p>
                    <span className="text-inkMuted">评估者：</span>
                    {ASSESSOR_TYPE_LABEL_ZH[row.assessorType]}
                  </p>
                  <p>
                    <span className="text-inkMuted">置信度：</span>
                    {EVIDENCE_CONFIDENCE_LABEL_ZH[row.confidence]}
                  </p>
                  <p>
                    <span className="text-inkMuted">隐私：</span>
                    {EVIDENCE_PRIVACY_LABEL_ZH[row.privacyLevel]}
                  </p>
                  {row.score !== null && (
                    <p className="sm:col-span-2">
                      <span className="text-inkMuted">评分：</span>
                      {row.score} · {EVIDENCE_SCORE_LABEL_ZH[row.score] ?? ''} ·{' '}
                      {row.scoreReason ?? '（未写理由）'}
                    </p>
                  )}
                  {row.evidenceAnchor && (
                    <p>
                      <span className="text-inkMuted">证据位置：</span>
                      {row.evidenceAnchor}
                    </p>
                  )}
                </div>

                {row.outputText && (
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-white p-2 font-sans text-[11px] text-ink">
                    {row.outputText}
                  </pre>
                )}

                {row.condition && (
                  <div className="mt-2 rounded border border-line bg-white p-2">
                    <p className="mb-1 font-medium text-ink">条件快照</p>
                    <div className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
                      <p>
                        <span className="text-inkMuted">任务/提示：</span>
                        {row.condition.prompt ?? '—'}
                      </p>
                      <p>
                        <span className="text-inkMuted">材料：</span>
                        {row.condition.materialSource ?? '—'}
                      </p>
                      <p>
                        <span className="text-inkMuted">时间限制：</span>
                        {row.condition.timeLimitMinutes === null
                          ? '未限时'
                          : `${row.condition.timeLimitMinutes} 分钟`}
                      </p>
                      <p>
                        <span className="text-inkMuted">允许工具：</span>
                        {row.condition.toolsAllowed.length > 0
                          ? row.condition.toolsAllowed.join('、')
                          : '无'}
                      </p>
                      <p>
                        <span className="text-inkMuted">受众：</span>
                        {row.condition.audience ?? '—'}
                      </p>
                      <p>
                        <span className="text-inkMuted">环境：</span>
                        {row.condition.environment ?? '—'}
                      </p>
                    </div>
                  </div>
                )}

                {row.dimensions && Object.keys(row.dimensions).length > 0 && (
                  <p className="mt-2">
                    <span className="text-inkMuted">评分维度：</span>
                    {Object.entries(row.dimensions)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' · ')}
                  </p>
                )}

                {row.artifact && (
                  <p className="mt-2">
                    <span className="text-inkMuted">附件（{row.artifact.privacyLevel}）：</span>
                    {/^https?:\/\//.test(row.artifact.fileUri) ? (
                      <a
                        href={row.artifact.fileUri}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand underline"
                      >
                        {row.artifact.fileUri}
                      </a>
                    ) : (
                      <span className="break-all">{row.artifact.fileUri}</span>
                    )}
                  </p>
                )}

                {row.note && (
                  <p className="mt-2">
                    <span className="text-inkMuted">备注：</span>
                    {row.note}
                  </p>
                )}

                {(row.parent || row.children.length > 0) && (
                  <div className="mt-2 border-t border-line pt-1.5">
                    <p className="text-inkMuted">证据链</p>
                    {row.parent && (
                      <p>
                        上一版本：{LEARNING_EVIDENCE_TYPE_CODE[row.parent.evidenceType]}{' '}
                        {LEARNING_EVIDENCE_TYPE_LABEL_ZH[row.parent.evidenceType]} ·{' '}
                        {formatDateTime(row.parent.createdAt)}
                      </p>
                    )}
                    {row.children.map((child) => (
                      <p key={child.id}>
                        下一版本：{LEARNING_EVIDENCE_TYPE_CODE[child.evidenceType]}{' '}
                        {LEARNING_EVIDENCE_TYPE_LABEL_ZH[child.evidenceType]} ·{' '}
                        {formatDateTime(child.createdAt)}
                      </p>
                    ))}
                  </div>
                )}

                {!row.independent && (
                  <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-1.5 text-[11px] text-amber-900">
                    {row.assistanceLevel === 'A4'
                      ? 'A4 代写/代答：只能作为辅助版本参考，不能计为独立成果或迁移证据。'
                      : '此记录使用过工具/反馈：单独标记，不与无辅助表现合并评分。'}
                  </p>
                )}
                <p className="mt-1 text-[10px] text-inkMuted">
                  下一阶段：
                  {next
                    ? `${LEARNING_EVIDENCE_TYPE_CODE[next]} ${LEARNING_EVIDENCE_TYPE_LABEL_ZH[next]}`
                    : '已到迁移验证（E5），本链结束'}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
