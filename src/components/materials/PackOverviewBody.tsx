'use client';

/**
 * 学习包总览（T13 §5）。
 *
 * 三块信息按"用户最想先知道的"排序：
 * 1. **这份材料学什么**（AI 学习目标 + 目标技能）—— 必须挂 AI 徽章，因为
 *    学习目标是模型总结的，不是原文；
 * 2. **大概要多久**（预计时长 + 条目数）；
 * 3. **先做什么后做什么**（`PackOrderList`）。
 *
 * 未建包时给一个按钮，而不是空白页 —— 空白页让用户不知道下一步该干什么。
 */

import { useState } from 'react';
import { AiDerivedCallout } from '@/components/materials/AiDerivedCallout';
import { PackOrderList } from '@/components/materials/PackOrderList';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { buildMaterialPackAction } from '@/lib/actions/materialPack';
import type { MaterialPackDto } from '@/lib/queries/materials';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;

const SKILL_LABELS: Record<string, string> = {
  READING: '阅读',
  WRITING: '写作',
  LISTENING: '听力',
  SPEAKING: '口语',
  VOCABULARY: '词汇',
  GRAMMAR: '语法',
};

export interface PackOverviewBodyProps {
  materialId: string;
  pack: MaterialPackDto;
  /** 材料还在待审核：建出来的是"半成品包"。 */
  provisional: boolean;
  /** 材料是否允许建包（处理中不允许）。 */
  canBuild: boolean;
}

export function PackOverviewBody({
  materialId,
  pack,
  provisional,
  canBuild,
}: PackOverviewBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);
  const built = pack.packId !== null;

  const build = async (rebuild: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await buildMaterialPackAction({ materialId, rebuild });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(
        rebuild
          ? `学习包已重建：${result.data.itemCount} 个条目 · 约 ${result.data.estimatedMinutes} 分钟`
          : `学习包已生成：${result.data.itemCount} 个条目 · 约 ${result.data.estimatedMinutes} 分钟`,
        'success',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-line bg-surface p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-[13px] font-semibold text-ink">学习包总览</h2>
          {pack.difficultyEstimate && (
            <span className="rounded border border-line bg-surfaceAlt px-1.5 py-0.5 text-[10px] text-inkMuted">
              难度 {pack.difficultyEstimate}
            </span>
          )}
          {provisional && (
            <span className="rounded border border-egYellow/60 bg-egYellow/10 px-1.5 py-0.5 text-[10px] text-ink">
              半成品包（AI 结果还没审完）
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {built ? (
            <>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => void build(true)}
                disabled={busy || !canBuild}
              >
                <Icon name="repeat" size={12} />
                重建学习包
              </button>
            </>
          ) : (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => void build(false)}
              disabled={busy || !canBuild}
            >
              <Icon name="plus" size={12} />
              生成学习包
            </button>
          )}
        </div>
      </header>

      {!built ? (
        <p className="text-[11px] leading-relaxed text-inkMuted">
          学习包只<strong className="text-ink">聚合引用</strong>：精读段落、已确认的词汇候选、
          练习集、重点句。不复制正文，所以原文修订后包里看到的永远是最新内容。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-inkMuted">
            <span>
              预计 <strong className="text-ink">{pack.estimatedMinutes}</strong> 分钟
            </span>
            <span>{pack.items.length} 个条目</span>
            {pack.targetSkills.length > 0 && (
              <span>
                目标技能：
                {pack.targetSkills.map((skill) => SKILL_LABELS[skill] ?? skill).join(' / ')}
              </span>
            )}
          </div>

          {pack.learningGoals.length > 0 && (
            <div className="rounded-md border border-line bg-surfaceAlt p-2">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-ink">学习目标</span>
                <AiDerivedCallout label="AI 总结" note="来自全文摘要，非原文" />
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-ink">
                {pack.learningGoals.map((goal) => (
                  <li key={goal}>{goal}</li>
                ))}
              </ul>
            </div>
          )}

          {pack.summary && (
            <details className="rounded-md border border-line bg-surfaceAlt p-2">
              <summary className="cursor-pointer text-[11px] font-medium text-ink">
                全文摘要
                <AiDerivedCallout label="AI 生成" className="ml-1.5" />
              </summary>
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-ink">
                {pack.summary.summaryZh || '（摘要内容为空）'}
              </p>
            </details>
          )}

          <PackOrderList items={pack.items} />
        </>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </section>
  );
}
