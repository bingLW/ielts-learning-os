'use client';

/**
 * Coach 页主体：6 步协议 + AI 使用统计 + 使用日志。
 *
 * 口径：A4 依赖占比衡量的是「产出交给 AI 的程度」，不是语言能力。
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ADOPTION_STATUS_LABEL_ZH,
  AI_ACTION_TYPE_LABEL_ZH,
  AI_A4_DEPENDENCY_WARN_PERCENT,
  AI_SUBSTITUTE_ASSISTANCE_LEVEL,
  AI_USAGE_NOTE_ZH,
  AI_USAGE_RECENT_DAYS,
  ASSISTANCE_LEVELS,
  ASSISTANCE_LEVEL_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
} from '@/lib/constants';
import type { AiUsageStats } from '@/lib/domain/coach';
import { a4DependencyWarning } from '@/lib/domain/coach';
import type { EvidencePickerOption } from '@/lib/queries/evidence';
import type { AiUsageRecordDto, AssistanceLevel } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { selectClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { AiUsageForm } from './AiUsageForm';
import { CoachProtocol } from './CoachProtocol';

export interface CoachPageBodyProps {
  usage: AiUsageRecordDto[];
  options: EvidencePickerOption[];
  stats: AiUsageStats;
}

export function CoachPageBody({ usage, options, stats }: CoachPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [formOpen, setFormOpen] = useState(false);
  const [levelFilter, setLevelFilter] = useState<AssistanceLevel | 'ALL'>('ALL');

  const filtered = useMemo(
    () => usage.filter((row) => levelFilter === 'ALL' || row.assistanceLevel === levelFilter),
    [usage, levelFilter],
  );
  const warning = a4DependencyWarning(stats.a4Share);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile
          label={`近 ${AI_USAGE_RECENT_DAYS} 天 AI 使用`}
          value={stats.total}
          unit="次"
          hint="只记录你主动登记的调用"
          tone="neutral"
        />
        <StatTile
          label="A4 依赖占比"
          value={`${stats.a4Share}%`}
          hint={
            warning
              ? `超过 ${AI_A4_DEPENDENCY_WARN_PERCENT}%：检查是否把产出交给了 AI`
              : `警戒线 ${AI_A4_DEPENDENCY_WARN_PERCENT}%；A4 永不算独立产出`
          }
          tone={warning ? 'warn' : 'output'}
        />
        <StatTile label="采纳" value={stats.adoptedCount} unit="次" hint="全部采纳的记录数" tone="plan" />
        <StatTile
          label="未采纳"
          value={stats.rejectedCount}
          unit="次"
          hint="AI 输出没有被采用的记录数"
          tone="mastery"
        />
      </div>

      <p className="rounded border border-line bg-surfaceAlt px-2 py-1.5 text-[11px] text-inkMuted">
        {AI_USAGE_NOTE_ZH}
      </p>

      <CoachProtocol />

      <Card
        title="AI 使用记录"
        description="记录支架层级与采纳情况；A4 记录会被单独标红。"
        actions={
          <Button variant={formOpen ? 'ghost' : 'primary'} size="sm" onClick={() => setFormOpen((v) => !v)}>
            <Icon name={formOpen ? 'close' : 'plus'} size={14} />
            {formOpen ? '收起' : '记录 AI 使用'}
          </Button>
        }
      >
        <div id="ai-usage" className="space-y-2">
          {formOpen && (
            <div className="rounded border border-line bg-surfaceAlt p-2">
              <AiUsageForm
                options={options}
                onSaved={() => {
                  setFormOpen(false);
                  router.refresh();
                }}
                onCancel={() => setFormOpen(false)}
                onToast={show}
              />
            </div>
          )}

          <div className="flex items-end gap-2">
            <label className="text-[10px] text-inkMuted">
              辅助级别
              <select
                aria-label="按辅助级别过滤"
                value={levelFilter}
                onChange={(event) =>
                  setLevelFilter(event.target.value as AssistanceLevel | 'ALL')
                }
                className={`${selectClass} mt-0.5 py-1 text-[11px]`}
              >
                <option value="ALL">全部</option>
                {ASSISTANCE_LEVELS.map((item) => (
                  <option key={item} value={item}>
                    {ASSISTANCE_LEVEL_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
            </label>
            <span className="pb-1 text-[10px] text-inkMuted">
              近 {AI_USAGE_RECENT_DAYS} 天共 {filtered.length} 条
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="还没有 AI 使用记录"
              description="先用自己完成一次 A0 尝试，再记录请求了哪一层提示；这样 AI 的帮助才是可核查的。"
              primary={{ label: '去记录 A0 尝试', href: '/evidence' }}
            />
          ) : (
            <ul className="divide-y divide-line rounded border border-line">
              {filtered.map((row) => (
                <li key={row.id} className="px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink">
                    <span className="text-inkMuted">{row.createdAt.slice(0, 10)}</span>
                    <span className="font-medium">{row.toolName}</span>
                    {row.modelVersion && (
                      <span className="text-inkMuted">({row.modelVersion})</span>
                    )}
                    <span
                      className={[
                        'rounded px-1 text-[10px]',
                        row.assistanceLevel === AI_SUBSTITUTE_ASSISTANCE_LEVEL
                          ? 'bg-red-100 text-red-800'
                          : 'bg-slate-100 text-slate-600',
                      ].join(' ')}
                    >
                      {ASSISTANCE_LEVEL_LABEL_ZH[row.assistanceLevel]}
                    </span>
                    <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                      {AI_ACTION_TYPE_LABEL_ZH[row.actionType]}
                    </span>
                    <span className="text-inkMuted">
                      {ADOPTION_STATUS_LABEL_ZH[row.adoptedOrRejected]}
                    </span>
                    {row.independent && (
                      <span className="text-[10px] text-emerald-700">独立（A0）</span>
                    )}
                  </div>
                  {row.purpose && <p className="mt-0.5 text-[11px] text-inkMuted">{row.purpose}</p>}
                  <p className="mt-0.5 text-[10px] text-inkMuted">
                    {row.evidenceId ? (
                      <a className="text-brand underline" href="/evidence">
                        证据 {row.evidenceSkill ? EVIDENCE_SKILL_LABEL_ZH[row.evidenceSkill] : ''}
                        {row.evidencePreview ? ` · ${row.evidencePreview.slice(0, 48)}` : ''}
                      </a>
                    ) : (
                      '未关联证据'
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
