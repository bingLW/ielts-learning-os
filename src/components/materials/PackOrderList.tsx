'use client';

/**
 * 学习包的训练顺序列表（T13 §5）。
 *
 * **不做拖拽**（本批）：拖拽要引入 dnd 依赖或手写 pointer 事件，而"上移/下移"
 * 两个按钮已经能表达"顺序"，且对触屏/键盘都友好。拖拽留到有真实需求时再说。
 *
 * 顺序调整目前**只影响本页展示**，不写库：包条目顺序的持久化需要单独的 action
 * （`sortOrder` 是包表字段，改它要连带重写 `orderingJson`），而本批的五个 action
 * 里没有这一条。这一点在界面上一句话说明，不做无声的假象。
 */

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { PackItemDto } from '@/lib/queries/materials';

const BTN_ICON =
  'inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-surface text-inkMuted transition-colors hover:bg-surfaceAlt hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';

const TYPE_LABELS: Record<string, string> = {
  CHUNK: '精读',
  EXERCISE_SET: '练习',
  VOCAB_CANDIDATE: '词汇',
  SENTENCE: '重点句',
  EXTRACTION: '分析',
};

export interface PackOrderListProps {
  items: PackItemDto[];
}

export function PackOrderList({ items }: PackOrderListProps) {
  /**
   * 本地只存 **id 顺序**，条目本体始终来自 props。
   *
   * 为什么不 `useState(items)`：重建包之后 `router.refresh()` 会送来新的 props，
   * 直接缓存对象数组会把它冻结在旧值上（用户会看到"重建了但列表没变"）。
   * 存 id 顺序 + 每次渲染按 props 重建，既保留用户的临时调整，又能跟上数据变化；
   * props 里新出现的 id 自动追加到末尾。
   */
  const [orderIds, setOrderIds] = useState<string[]>(() => items.map((item) => item.id));

  const byId = new Map(items.map((item) => [item.id, item]));
  const order = [
    ...orderIds.map((id) => byId.get(id)).filter((item): item is PackItemDto => item !== undefined),
    ...items.filter((item) => !orderIds.includes(item.id)),
  ];

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = order.map((item) => item.id);
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setOrderIds(next);
  };

  if (order.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line bg-surfaceAlt p-3 text-[11px] text-inkMuted">
        学习包还是空的。先审核分析结果、生成练习，再回来点「生成学习包」。
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-inkMuted">
        建议训练顺序（上移/下移只调整本页展示，暂不写入数据库）
      </p>
      <ol className="space-y-1">
        {order.map((item, index) => (
          <li
            key={item.id}
            className={[
              'flex items-center gap-2 rounded-md border px-2 py-1.5',
              item.missing ? 'border-dashed border-line bg-surfaceAlt/60' : 'border-line bg-surface',
            ].join(' ')}
          >
            <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-inkMuted">
              {index + 1}
            </span>
            <span className="shrink-0 rounded border border-line bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
              {TYPE_LABELS[item.itemType] ?? item.itemType}
            </span>
            <div className="min-w-0 flex-1">
              {item.missing ? (
                <p className="text-[11px] italic text-inkMuted">内容已移除</p>
              ) : item.href ? (
                <a
                  href={item.href}
                  className="block truncate text-[12px] text-ink hover:text-brand hover:underline"
                >
                  {item.label}
                </a>
              ) : (
                <p className="truncate text-[12px] text-ink">{item.label}</p>
              )}
              {!item.missing && item.secondary && (
                <p className="truncate text-[10px] text-inkMuted">{item.secondary}</p>
              )}
            </div>
            {typeof item.estimatedMinutes === 'number' && (
              <span className="shrink-0 text-[10px] tabular-nums text-inkMuted">
                {item.estimatedMinutes} 分钟
              </span>
            )}
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className={BTN_ICON}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label="上移"
              >
                <Icon name="up" size={12} />
              </button>
              <button
                type="button"
                className={BTN_ICON}
                onClick={() => move(index, 1)}
                disabled={index === order.length - 1}
                aria-label="下移"
              >
                <Icon name="down" size={12} />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
