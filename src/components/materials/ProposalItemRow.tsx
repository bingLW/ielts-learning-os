'use client';

/**
 * 一条草案条目（F-03）。
 *
 * 用户在这里能做三件事：**勾选**（确认后才写计划）、**改分钟**（步进 = 粒度）、
 * **改日期**。三件事都即时提交（乐观更新 + 失败回滚），因为没有"保存"按钮 ——
 * 草案的每一步修改都应该是可撤销的小动作，而不是一次需要记住按 Ctrl+S 的编辑。
 *
 * 已经落地成 PlanTask 的条目（`planTaskId !== null`）**全部锁死**：改它不会改到
 * 计划里那条任务，只会制造"草案显示 30 分钟、计划里是 60 分钟"的错觉。
 */

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { updateProposalItemAction } from '@/lib/actions/materialPack';
import type { ProposalItemDto } from '@/lib/queries/materials';

const FIELD =
  'rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink outline-none focus:border-brand';

const MODULE_LABELS: Record<string, string> = {
  VOCAB_REVIEW: '词汇复习',
  READING: '阅读',
  SENTENCE: '句子',
  GRAMMAR: '语法',
  LISTENING: '听力',
  SPEAKING: '口语',
  WRITING: '写作',
};

export interface ProposalItemRowProps {
  item: ProposalItemDto;
  granularity: number;
  /** 上级是否有请求在飞（避免连点并发）。 */
  busy: boolean;
  onUpdate: (patch: {
    selected?: boolean;
    finalMinutes?: number;
    finalDate?: string;
  }) => Promise<string | null>;
}

export function ProposalItemRow({ item, granularity, busy, onUpdate }: ProposalItemRowProps) {
  const [fieldError, setFieldError] = useState<string | null>(null);
  const locked = item.planTaskId !== null;

  const submit = async (patch: {
    selected?: boolean;
    finalMinutes?: number;
    finalDate?: string;
  }): Promise<void> => {
    setFieldError(null);
    const error = await onUpdate(patch);
    if (error) setFieldError(error);
  };

  return (
    <li
      className={[
        'rounded-md border px-2 py-1.5',
        item.selected && !locked ? 'border-line bg-surface' : 'border-line bg-surfaceAlt/60',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 shrink-0 accent-brand"
          checked={item.selected}
          disabled={busy || locked}
          onChange={(event) => void submit({ selected: event.target.checked })}
          aria-label={`勾选：${item.title}`}
        />
        <span className="shrink-0 rounded border border-line bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
          {MODULE_LABELS[item.module] ?? item.module}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{item.title}</span>

        <label className="flex shrink-0 items-center gap-1 text-[10px] text-inkMuted">
          分钟
          <input
            type="number"
            className={`${FIELD} w-16 tabular-nums`}
            value={item.finalMinutes ?? item.suggestedMinutes}
            min={15}
            max={240}
            step={granularity}
            disabled={busy || locked}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next < 15 || next > 240 || next % 15 !== 0) {
                setFieldError('分钟必须是 15–240 之间、15 的倍数');
                return;
              }
              void submit({ finalMinutes: next });
            }}
          />
        </label>

        <label className="flex shrink-0 items-center gap-1 text-[10px] text-inkMuted">
          日期
          <input
            type="date"
            className={`${FIELD} tabular-nums`}
            value={item.finalDate ?? item.suggestedDate}
            disabled={busy || locked}
            onChange={(event) => {
              const next = event.target.value;
              // 清空日期 = 回到建议日期，不发请求
              if (next.length === 0) return;
              void submit({ finalDate: next });
            }}
          />
        </label>

        {locked && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-egGreen/50 bg-egGreen/10 px-1.5 py-0.5 text-[10px] text-egGreen">
            <Icon name="check" size={10} />
            已写入计划
          </span>
        )}
      </div>

      {(item.reason || fieldError) && (
        <p className="mt-1 pl-[22px] text-[10px] leading-relaxed">
          {fieldError ? (
            <span className="text-egRed">{fieldError}</span>
          ) : (
            <span className="text-inkMuted">{item.reason}</span>
          )}
        </p>
      )}
    </li>
  );
}
