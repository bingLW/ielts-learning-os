'use client';

/**
 * 任务草案面板（T13 §5，F-02 / F-03）。
 *
 * 产品口径：**草案不等于计划**。确认之前一条 PlanTask 都不会写库，
 * 所以"确认写入计划"旁边必须常驻一句话说明这件事 —— 用户最怕的是
 * "我点了一下，日历就被塞满了"。
 *
 * 超预算时按钮**禁用并列出逐日明细**，而不是点下去才报错：
 * 报错发生在点之后，用户会以为是自己操作错了；列在前面，才知道是数据该改。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import {
  confirmTaskProposalAction,
  createTaskProposalAction,
  discardTaskProposalAction,
  updateProposalItemAction,
  type CreateProposalActionData,
} from '@/lib/actions/materialPack';
import type { TaskProposalDto } from '@/lib/queries/materials';
import { ProposalItemRow } from './ProposalItemRow';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_DANGER = `${BTN} border-transparent text-inkMuted hover:bg-surfaceAlt hover:text-egRed`;

export interface TaskProposalPanelProps {
  materialId: string;
  proposal: TaskProposalDto | null;
  /** 材料是否允许生成草案。 */
  canCreate: boolean;
  /**
   * 草案基准日（`YYYY-MM-DD`）。
   *
   * 由**服务端**用 `lib/date` 的 `today()` 算好传进来：客户端自己 `new Date()`
   * 会跟着浏览器时区漂，跨时区用户看到的"今天"和计划里的"今天"就不是同一天。
   */
  baseDate: string;
}

export function TaskProposalPanel({
  materialId,
  proposal,
  canCreate,
  baseDate,
}: TaskProposalPanelProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);

  // 草案由页面注入；生成/确认后靠 `router.refresh()` 拿新数据（服务端是唯一真相）
  const days = proposal?.days ?? [];
  const violations = proposal?.violations ?? [];
  const selectedCount = (proposal?.items ?? []).filter((item) => item.selected).length;
  const confirmedCount = (proposal?.items ?? []).filter((item) => item.planTaskId).length;

  // ── 生成（建包动作在 PackOverviewBody；这里只负责"排草案"） ──
  const createProposal = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await createTaskProposalAction({ materialId, baseDate, force: true });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      const data: CreateProposalActionData = result.data;
      show(
        `草案已生成：${data.items} 条 · 共 ${data.totalMinutes} 分钟`
        + (data.overflowDays > 0 ? ` · 超出预算范围 ${data.overflowDays} 天` : ''),
        'success',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  // ── 改一条 ──
  const updateItem = async (
    itemId: string,
    patch: { selected?: boolean; finalMinutes?: number; finalDate?: string },
  ): Promise<string | null> => {
    const result = await updateProposalItemAction({ itemId, ...patch });
    if (!result.ok) return result.error;
    router.refresh();
    return null;
  };

  // ── 确认 ──
  const confirm = async (): Promise<void> => {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await confirmTaskProposalAction({ proposalId: proposal.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(
        `已写入 ${result.data.created} 条计划任务 · 共 ${result.data.totalMinutes} 分钟`
        + (result.data.failed > 0 ? ` · ${result.data.failed} 条失败` : ''),
        'success',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  // ── 丢弃 ──
  const discard = async (): Promise<void> => {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await discardTaskProposalAction({ proposalId: proposal.id });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('草案已丢弃（已经写入的计划任务不受影响）', 'success');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const canConfirm =
    proposal !== null
    && proposal.status === 'draft'
    && selectedCount > 0
    && violations.length === 0
    && !busy;

  return (
    <section className="space-y-2 rounded-md border border-line bg-surface p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-[13px] font-semibold text-ink">任务草案</h2>
          {proposal && (
            <span
              className={[
                'rounded border px-1.5 py-0.5 text-[10px]',
                proposal.status === 'draft'
                  ? 'border-egYellow/60 bg-egYellow/10 text-ink'
                  : proposal.status === 'confirmed'
                    ? 'border-egGreen/50 bg-egGreen/10 text-egGreen'
                    : 'border-line bg-surfaceAlt text-inkMuted',
              ].join(' ')}
            >
              {proposal.status === 'draft'
                ? '待确认'
                : proposal.status === 'confirmed'
                  ? '已确认'
                  : '已丢弃'}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={proposal ? BTN_SECONDARY : BTN_PRIMARY}
            onClick={() => void createProposal()}
            disabled={busy || !canCreate}
          >
            <Icon name="calendar" size={12} />
            {proposal ? '重新排一份草案' : '生成任务草案'}
          </button>
        </div>
      </header>

      {!proposal ? (
        <p className="text-[11px] leading-relaxed text-inkMuted">
          按每日可用预算把学习包内容排到具体日期。草案只是建议 —— 勾选并点「确认写入计划」
          之后才会真正出现在每日计划里。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-inkMuted">
            <span>
              共 <strong className="text-ink">{proposal.items.length}</strong> 条
            </span>
            <span>
              合计 <strong className="text-ink">{proposal.totalMinutes}</strong> 分钟
            </span>
            <span>基准日 {proposal.baseDate}</span>
            <span>基准日预算 {proposal.budgetMinutes} 分钟</span>
            {proposal.overflowDays > 0 && (
              <span className="text-egYellow">超出预算范围 {proposal.overflowDays} 天</span>
            )}
          </div>

          {/* rationale 原文展示：用户有权看到"为什么这样拆" */}
          {proposal.rationale && (
            <p className="rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-ink">
              {proposal.rationale}
            </p>
          )}

          {/* 每日分配摘要 */}
          <div className="flex flex-wrap gap-1.5">
            {days.map((day) => (
              <span
                key={day.date}
                className={[
                  'rounded border px-1.5 py-0.5 text-[10px] tabular-nums',
                  day.isRestDay
                    ? 'border-line bg-surfaceAlt text-inkMuted'
                    : 'border-line bg-surface text-ink',
                ].join(' ')}
              >
                {day.date}
                {day.isRestDay ? ' 休息' : ` · ${day.minutes} 分钟`}
              </span>
            ))}
          </div>

          {violations.length > 0 && (
            <div className="rounded-md border border-egRed/50 bg-egRed/10 p-2">
              <p className="text-[11px] font-medium text-ink">草案超出每日预算，无法确认</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[10px] leading-relaxed text-ink">
                {violations.map((row) => (
                  <li key={row.date}>
                    {row.date}：预算 {row.budgetMinutes} 分钟，草案排了 {row.allocatedMinutes} 分钟
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] text-inkMuted">
                改小某几条的分钟数，或把它们挪到别的日期，就能确认。
              </p>
            </div>
          )}

          <ul className="space-y-1">
            {proposal.items.map((item) => (
              <ProposalItemRow
                key={item.id}
                item={item}
                granularity={item.granularity}
                busy={busy}
                onUpdate={(patch) => updateItem(item.id, patch)}
              />
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => void confirm()}
              disabled={!canConfirm}
            >
              <Icon name="check" size={12} />
              确认写入计划（{selectedCount} 条）
            </button>
            <span className="text-[10px] leading-relaxed text-inkMuted">
              确认后才会写入每日计划
              {confirmedCount > 0 ? `（已有 ${confirmedCount} 条写入过）` : ''}
            </span>
            {proposal.status === 'draft' && (
              <button
                type="button"
                className={`${BTN_DANGER} ml-auto`}
                onClick={() => void discard()}
                disabled={busy}
              >
                丢弃草案
              </button>
            )}
          </div>
        </>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </section>
  );
}
