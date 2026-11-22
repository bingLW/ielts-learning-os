'use client';

/**
 * 危险区（删除材料，G-01）。
 *
 * 删除是**不可撤销**的，所以这里做三件事：
 * 1. 先把账算清楚：删多少行、保留多少（词条/计划任务/作答）—— 用户在按下去之前
 *    就该知道"我的词库不会跟着没"；
 * 2. 要求手输 `DELETE`（不是"点两次"，因为点两次拦不住手快）；
 * 3. 保留项单独列出来，并在按钮上写明数字。
 *
 * 删除本身复用 T08 的 `deleteMaterialAction`；级联完整性在 T14 补，本批不扩。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { deleteMaterialAction } from '@/lib/actions/materials';
import type { DeletionPreviewDto } from '@/lib/queries/materials';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';
const BTN_DANGER = `${BTN} border-egRed/60 bg-egRed text-white hover:bg-egRed/90`;

const CONFIRM_WORD = 'DELETE';

export interface DangerZoneProps {
  preview: DeletionPreviewDto;
}

export function DangerZone({ preview }: DangerZoneProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = text === CONFIRM_WORD;

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await deleteMaterialAction({
        materialId: preview.materialId,
        confirmText: text,
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(`已删除材料，共清理 ${result.data.deletedRows} 行派生数据`, 'success');
      // 材料已经不存在，回材料库（刷新当前页会 404）
      router.push('/materials');
    } finally {
      setBusy(false);
    }
  };

  const rows: { label: string; value: string; keep: boolean }[] = [
    { label: '会被删除的派生行', value: `${preview.deleteRows} 行`, keep: false },
    { label: '保留的词条（已同步进词库）', value: `${preview.keepVocabulary} 条`, keep: true },
    { label: '保留的计划任务（已确认的草案）', value: `${preview.keepPlanTasks} 条`, keep: true },
    { label: '保留的作答记录（已写入证据）', value: `${preview.keepAttempts} 条`, keep: true },
  ];

  return (
    <section className="space-y-2 rounded-md border border-egRed/40 bg-surface p-3">
      <header className="flex items-center gap-1.5">
        <Icon name="alert" size={13} className="text-egRed" />
        <h2 className="text-[13px] font-semibold text-ink">危险区</h2>
      </header>

      <p className="text-[11px] leading-relaxed text-inkMuted">
        删除材料会清理它的原文、分块、分析结果、词汇候选、练习与草案。
        <strong className="text-ink">已经沉淀出去的成果不会跟着消失</strong>
        —— 但删除本身不可撤销。
      </p>

      <ul className="divide-y divide-line rounded-md border border-line">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[11px] text-inkMuted">{row.label}</span>
            <span
              className={[
                'text-[11px] tabular-nums',
                row.keep ? 'text-egGreen' : 'text-egRed',
              ].join(' ')}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>

      {preview.fileSizeBytes !== null && (
        <p className="text-[10px] text-inkMuted">
          本地原文文件约 {Math.max(1, Math.round(preview.fileSizeBytes / 1024))} KB，会一并删除。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`输入 ${CONFIRM_WORD} 以确认`}
          className="w-40 rounded border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-egRed"
          disabled={busy}
          aria-label="删除确认词"
        />
        <button
          type="button"
          className={BTN_DANGER}
          onClick={() => void remove()}
          disabled={!ready || busy}
        >
          <Icon name="trash" size={12} />
          永久删除这份材料
        </button>
        <span className="text-[10px] text-inkMuted">
          必须手输 {CONFIRM_WORD} 才能启用
        </span>
      </div>

      <Toast toast={toast} onDismiss={dismiss} />
    </section>
  );
}
