'use client';

/**
 * 复测与迁移页主体：到期队列 + 完成/跳过 + 加入今日计划。
 *
 * 口径：这是「技能表现」的复测队列，不是错题/词汇复习；两套队列不合并、不共享状态。
 */

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addRetestToPlanAction, skipRetestAction } from '@/lib/actions/retest';
import {
  EVIDENCE_SKILLS,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  RETEST_A0_NOTE_ZH,
  RETEST_QUEUE_NOTE_ZH,
  RETEST_STATUS_LABEL_ZH,
  RETEST_STATUSES,
  RETEST_TRANSFER_NOTE_ZH,
  RETEST_TYPE_LABEL_ZH,
} from '@/lib/constants';
import type { RetestStats } from '@/lib/domain/retest';
import type {
  EvidenceSkill,
  RetestQueueItemDto,
  RetestStatus,
  RetestType,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { selectClass } from '@/components/ui/FormField';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface RetestPageBodyProps {
  rows: RetestQueueItemDto[];
  stats: RetestStats;
  /** 服务器按用户配置时区计算的业务日期，避免客户端时区漂移。 */
  todayStr: string;
}

const RETEST_TYPES_ORDER: RetestType[] = ['IMMEDIATE', 'DELAYED', 'APPLIED', 'TRANSFER'];

function statusTone(status: RetestStatus): string {
  switch (status) {
    case 'PENDING':
      return 'bg-egYellow/20 text-ink';
    case 'DONE':
      return 'bg-egGreen/15 text-ink';
    default:
      return 'bg-surfaceAlt text-inkMuted';
  }
}

export function RetestPageBody({ rows, stats, todayStr }: RetestPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();

  const [skillFilter, setSkillFilter] = useState<EvidenceSkill | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<RetestType | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<RetestStatus | 'ALL'>('PENDING');
  const [skipTarget, setSkipTarget] = useState<RetestQueueItemDto | null>(null);

  const dueRows = rows.filter(
    (row) => row.status === 'PENDING' && row.dueDate <= todayStr && !row.planTaskId,
  );

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (skillFilter !== 'ALL' && row.parentSkill !== skillFilter) return false;
        if (typeFilter !== 'ALL' && row.retestType !== typeFilter) return false;
        if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
        return true;
      }),
    [rows, skillFilter, typeFilter, statusFilter],
  );

  const addAllToPlan = () => {
    if (dueRows.length === 0) return;
    startTransition(async () => {
      let created = 0;
      let failed = 0;
      for (const row of dueRows) {
        const result = await addRetestToPlanAction({ scheduleId: row.id });
        if (result.ok) created += 1;
        else failed += 1;
      }
      show(
        failed === 0
          ? `已加入今日计划 ${created} 条复测任务`
          : `成功 ${created} 条，失败 ${failed} 条（可能未激活阶段）`,
        failed === 0 ? 'success' : 'error',
      );
      router.refresh();
    });
  };

  const addOne = (row: RetestQueueItemDto) => {
    startTransition(async () => {
      const result = await addRetestToPlanAction({ scheduleId: row.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('已加入今日计划（模块：证据复测）', 'success');
      router.refresh();
    });
  };

  const confirmSkip = () => {
    if (!skipTarget) return;
    const target = skipTarget;
    startTransition(async () => {
      const result = await skipRetestAction({ scheduleId: target.id });
      setSkipTarget(null);
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('已跳过这次复测（排期保留，可追溯）', 'success');
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">复测与迁移</h1>
          <p className="text-xs text-inkMuted">
            D0 即时 → D7 延迟 → D30 实际应用 → D84 迁移验证 · 复测必须 A0 无辅助
          </p>
        </div>
        {dueRows.length > 0 && (
          <Button variant="primary" size="sm" onClick={addAllToPlan} disabled={pending}>
            把到期复测加入今日计划（{dueRows.length}）
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="逾期" value={stats.overdue} unit="条" tone="warn" hint="已过到期日仍未完成" />
        <StatTile label="今日到期" value={stats.dueToday} unit="条" tone="plan" hint="今天完成的顺序优先" />
        <StatTile label="未来 7 天" value={stats.next7} unit="条" tone="neutral" hint="提前知道，不提前占计划" />
        <StatTile
          label="待完成总计"
          value={stats.pending}
          unit="条"
          tone="output"
          hint={`已完成 ${stats.done} · 已跳过 ${stats.skipped}`}
        />
      </div>

      <div className="space-y-1 rounded border border-line bg-surfaceAlt px-2 py-1.5 text-[11px] text-inkMuted">
        <p>{RETEST_QUEUE_NOTE_ZH}</p>
        <p>{RETEST_A0_NOTE_ZH}</p>
        <p>{RETEST_TRANSFER_NOTE_ZH}</p>
      </div>

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
            阶段
            <select
              aria-label="按复测阶段过滤"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as RetestType | 'ALL')}
              className={`${selectClass} mt-0.5 py-1 text-[11px]`}
            >
              <option value="ALL">全部</option>
              {RETEST_TYPES_ORDER.map((type) => (
                <option key={type} value={type}>
                  {RETEST_TYPE_LABEL_ZH[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] text-inkMuted">
            状态
            <select
              aria-label="按状态过滤"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as RetestStatus | 'ALL')}
              className={`${selectClass} mt-0.5 py-1 text-[11px]`}
            >
              <option value="ALL">全部</option>
              {RETEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {RETEST_STATUS_LABEL_ZH[status]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          title="当前筛选下没有复测排期"
          description="基线证据保存后会自动排 D0/D7/D30/D84 四段复测；也可以在证据列表里手动补排。"
          primary={{ label: '去 Evidence Center', href: '/evidence' }}
          secondary={{ label: '查看全部状态', onClick: () => setStatusFilter('ALL') }}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => {
            const due = row.status === 'PENDING' && row.dueDate <= todayStr;
            return (
              <Card key={row.id} dense>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className={`rounded px-1.5 py-0.5 ${statusTone(row.status)}`}>
                        {RETEST_STATUS_LABEL_ZH[row.status]}
                      </span>
                      <span className="text-ink">
                        {EVIDENCE_SKILL_LABEL_ZH[row.parentSkill]} ·{' '}
                        {RETEST_TYPE_LABEL_ZH[row.retestType]}
                      </span>
                      <span className="text-inkMuted">
                        到期 {row.dueDate} · {row.estMinutes} 分钟
                      </span>
                      {row.overdueDays > 0 && row.status === 'PENDING' && (
                        <span className="text-egRed">逾期 {row.overdueDays} 天</span>
                      )}
                      {row.planTaskId && row.status === 'PENDING' && (
                        <span className="text-egGreen">已加入计划</span>
                      )}
                    </div>
                    <p className="text-[10px] text-inkMuted">
                      父证据：{LEARNING_EVIDENCE_TYPE_LABEL_ZH[row.parentType]}
                      {row.parentPreview ? ` · ${row.parentPreview}` : ''}
                    </p>
                    <p className="text-[10px] text-inkMuted">
                      完成后记录为：{RETEST_TYPE_LABEL_ZH[row.retestType]}（必须 A0）
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={`/evidence?retest=${row.id}`}
                      className="inline-flex items-center rounded border border-line bg-surface px-2 py-1 text-[11px] text-ink hover:border-brand"
                      aria-disabled={row.status !== 'PENDING'}
                      onClick={(event) => {
                        if (row.status !== 'PENDING') event.preventDefault();
                      }}
                    >
                      完成复测
                    </Link>
                    {row.status === 'PENDING' && !row.planTaskId && due && (
                      <Button size="sm" variant="secondary" onClick={() => addOne(row)} disabled={pending}>
                        加入今日计划
                      </Button>
                    )}
                    {row.status === 'PENDING' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSkipTarget(row)}
                        disabled={pending}
                      >
                        跳过
                      </Button>
                    )}
                    {row.parentEvidenceId && (
                      <Link
                        href="/evidence"
                        className="text-[11px] text-inkMuted underline-offset-2 hover:underline"
                      >
                        查看证据
                      </Link>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={skipTarget !== null}
        title="跳过这次复测？"
        description={
          skipTarget
            ? `${EVIDENCE_SKILL_LABEL_ZH[skipTarget.parentSkill]} · ${RETEST_TYPE_LABEL_ZH[skipTarget.retestType]}（到期 ${skipTarget.dueDate}）。跳过后排期保留，但不会再提醒。`
            : ''
        }
        confirmLabel="跳过"
        danger
        onCancel={() => setSkipTarget(null)}
        onConfirm={confirmSkip}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
