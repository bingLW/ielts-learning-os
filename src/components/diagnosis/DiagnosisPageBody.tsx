'use client';

/**
 * 障碍诊断页主体：统计 + 过滤 + 新建诊断 + 障碍卡片。
 *
 * 口径：诊断记录的是「哪一环卡住」，不是能力分数；每轮只聚焦一个障碍。
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveBarrierAction } from '@/lib/actions/barrier';
import {
  BARRIER_FOCUS_NOTE_ZH,
  BARRIER_STATUSES,
  BARRIER_STATUS_LABEL_ZH,
  EVIDENCE_SKILLS,
  EVIDENCE_SKILL_LABEL_ZH,
} from '@/lib/constants';
import type { BarrierStats } from '@/lib/domain/barrier';
import type {
  BarrierDiagnosisDto,
  BarrierEvidenceOptionsBySkill,
  BarrierStatus,
  EvidenceSkill,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { selectClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { BarrierCard } from './BarrierCard';
import { BarrierForm } from './BarrierForm';

export interface DiagnosisPageBodyProps {
  rows: BarrierDiagnosisDto[];
  optionsBySkill: BarrierEvidenceOptionsBySkill;
  stats: BarrierStats;
}

export function DiagnosisPageBody({ rows, optionsBySkill, stats }: DiagnosisPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();

  const [formOpen, setFormOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<BarrierDiagnosisDto | null>(null);
  const [skillFilter, setSkillFilter] = useState<EvidenceSkill | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<BarrierStatus | 'ALL'>('ACTIVE');
  const [includeArchived, setIncludeArchived] = useState(false);

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (!includeArchived && row.archivedAt !== null) return false;
        if (skillFilter !== 'ALL' && row.skill !== skillFilter) return false;
        if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
        return true;
      }),
    [rows, includeArchived, skillFilter, statusFilter],
  );

  const confirmArchive = () => {
    if (!archiveTarget) return;
    startTransition(async () => {
      const result = await archiveBarrierAction({ id: archiveTarget.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('障碍已归档（历史保留）', 'success');
      setArchiveTarget(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="诊断中" value={stats.activeCount} unit="条" hint="未解决且未归档" tone="warn" />
        <StatTile label="已解决" value={stats.resolvedCount} unit="条" hint="至少一条修复完成并有后测样本" tone="mastery" />
        <StatTile
          label="当前聚焦"
          value={stats.focusSkill ? EVIDENCE_SKILL_LABEL_ZH[stats.focusSkill] : '未设置'}
          hint="每轮只聚焦一个主要障碍"
          tone="plan"
        />
        <StatTile
          label="涉及技能"
          value={stats.skillsWithActive.length}
          unit="项"
          hint={
            stats.skillsWithActive.length > 0
              ? stats.skillsWithActive.map((skill) => EVIDENCE_SKILL_LABEL_ZH[skill]).join(' / ')
              : '暂无诊断中的障碍'
          }
          tone="neutral"
        />
      </div>

      <p className="rounded border border-line bg-surfaceAlt px-2 py-1.5 text-[11px] text-inkMuted">
        {BARRIER_FOCUS_NOTE_ZH}
      </p>

      <Card dense>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[10px] text-inkMuted">
            技能
            <select
              aria-label="按技能过滤"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value as EvidenceSkill | 'ALL')}
              className={`${selectClass} mt-0.5 py-1 text-[11px]`}
            >
              <option value="ALL">全部</option>
              {EVIDENCE_SKILLS.map((skill) => (
                <option key={skill} value={skill}>
                  {EVIDENCE_SKILL_LABEL_ZH[skill]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] text-inkMuted">
            状态
            <select
              aria-label="按状态过滤"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as BarrierStatus | 'ALL')}
              className={`${selectClass} mt-0.5 py-1 text-[11px]`}
            >
              <option value="ALL">全部</option>
              {BARRIER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {BARRIER_STATUS_LABEL_ZH[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 pb-1 text-[11px] text-ink">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            含归档
          </label>
          <div className="ml-auto">
            <Button
              variant={formOpen ? 'ghost' : 'primary'}
              size="sm"
              onClick={() => setFormOpen((open) => !open)}
            >
              <Icon name={formOpen ? 'close' : 'plus'} size={14} />
              {formOpen ? '收起' : '记录障碍'}
            </Button>
          </div>
        </div>

        {formOpen && (
          <div className="mt-2 rounded border border-line bg-surfaceAlt p-2">
            <BarrierForm
              optionsBySkill={optionsBySkill}
              onSaved={() => {
                setFormOpen(false);
                router.refresh();
              }}
              onCancel={() => setFormOpen(false)}
              onToast={show}
            />
          </div>
        )}
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          title="当前筛选下没有障碍记录"
          description="先用 Evidence Center 留下原始样本，再记录卡住的那一环：是词汇、切分、句法，还是注意负荷。"
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => (
            <BarrierCard
              key={row.id}
              barrier={row}
              options={optionsBySkill[row.skill] ?? []}
              onToast={show}
              onArchiveRequest={setArchiveTarget}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        title="归档这条障碍诊断？"
        description={
          archiveTarget
            ? `${EVIDENCE_SKILL_LABEL_ZH[archiveTarget.skill]} · ${archiveTarget.barrierLabel}。归档后默认不再显示，历史修复记录保留。`
            : undefined
        }
        confirmLabel="归档"
        danger
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
