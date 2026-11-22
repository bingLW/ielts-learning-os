'use client';

/**
 * 原文里的词汇气泡（词汇辅助模式）。
 *
 * 交互取舍：
 * - **悬停 + 键盘聚焦 + 点击**都可打开：只做 hover 的话触屏设备永远看不到释义；
 * - **释义来源必须区分**（T12 / U-2）：`library` 是词库里人确认过的释义，正常展示；
 *   `ai` 是 AI 候选释义，必须带 `AiDerivedCallout` 标注 —— 把 AI 释义打扮成词典释义
 *   是这个功能最容易犯的错，也是学生最容易被误导的地方；
 * - **能一键去审核**：候选还没进词库时给出入口，否则用户看到"有个词被标黄了"
 *   却找不到该去哪儿处理它；
 * - 找不到释义字段时不显示空壳，只显示词形本身。
 */

import { useState, type ReactNode } from 'react';
import { AiDerivedCallout } from './AiDerivedCallout';

export interface VocabHoverCardProps {
  /** 词形（已在查询层定位到原文，大小写可能不同）。 */
  lemma: string;
  pos: string | null;
  definitionZh: string | null;
  /** 释义来源：主库（人确认过）还是 AI 候选。 */
  definitionSource: 'library' | 'ai';
  /** 对应的词汇候选 id（没物化过就是 null）。 */
  candidateId: string | null;
  /** 用于拼「去审核这个词」的链接。 */
  materialId: string;
  children: ReactNode;
}

export function VocabHoverCard({
  lemma,
  pos,
  definitionZh,
  definitionSource,
  candidateId,
  materialId,
  children,
}: VocabHoverCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={`词汇提示：${lemma}`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help rounded-sm bg-egYellow/20 decoration-brand/60 decoration-dotted underline-offset-2 hover:bg-egYellow/35 focus:outline-none focus:ring-2 focus:ring-brand/40"
      >
        {children}
      </span>

      {open && (
        <span
          role="note"
          className="absolute left-0 top-full z-20 mt-1 block w-56 rounded-md border border-line bg-surface p-2 text-left shadow-lg"
        >
          <span className="flex flex-wrap items-baseline gap-1">
            <span className="text-xs font-semibold text-ink">{lemma}</span>
            {pos && <span className="font-mono text-[10px] text-inkMuted">{pos}</span>}
            {definitionSource === 'library' && (
              <span className="rounded border border-egGreen/40 bg-egGreen/10 px-1 text-[9px] text-egGreen">
                词库释义
              </span>
            )}
          </span>

          {definitionZh ? (
            <span className="mt-0.5 block text-[11px] leading-relaxed text-ink">
              {definitionZh}
            </span>
          ) : (
            <span className="mt-0.5 block text-[11px] text-inkMuted">这条提示没有释义</span>
          )}

          {definitionSource === 'ai' && <AiDerivedCallout className="mt-1" note="请以词典为准" />}

          {candidateId && (
            <a
              href={`/materials/${materialId}/vocabulary#candidate-${candidateId}`}
              className="mt-1 block text-[10px] text-brand underline-offset-2 hover:underline"
            >
              去审核这条候选
            </a>
          )}
        </span>
      )}
    </span>
  );
}
