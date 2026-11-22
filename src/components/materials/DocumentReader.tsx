'use client';

/**
 * 阅读器（原文 / 词汇辅助）。
 *
 * 三个设计决定：
 * 1. **模式切换走 URL**（`?mode=vocab_assist`）而不是本地 state：刷新、分享、
 *    浏览器后退都能保持同一个视图，也让"原文模式"成为一个可验证的独立 URL。
 *    `router.replace(..., { scroll: false })` 避免切模式时页面被拽回顶部。
 * 2. **原创模式不渲染任何 AI 内容**：`view.chunks[*].hints` 在原文模式下由查询层
 *    保证为空（`getReaderView` 提前 return），这里再按 `mode` 兜一层。
 * 3. **定位高亮只持续 2s**：从目录或分析页跳过来时给一次视觉落点，之后自动消失，
 *    否则永久高亮会让"当前在看的段落"失去意义。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReaderViewDto, TocItemDto } from '@/lib/queries/materials';
import { AiDerivedCallout } from './AiDerivedCallout';
import { ChunkBlock } from './ChunkBlock';
import { InjectionNotice } from './InjectionNotice';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

const HIGHLIGHT_MS = 2000;

export interface DocumentReaderProps {
  view: ReaderViewDto;
  toc: TocItemDto[];
  /** 从 `?chunk=` 传入：需要滚动并闪烁的 chunk。 */
  highlightChunkId?: string;
}

export function DocumentReader({ view, toc, highlightChunkId }: DocumentReaderProps) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(null);

  // 进入页面时定位一次：滚动 + 闪烁 2s
  useEffect(() => {
    if (!highlightChunkId) return;
    const element = document.getElementById(`chunk-${highlightChunkId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(highlightChunkId);
    const timer = setTimeout(() => setActiveId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightChunkId]);

  const switchMode = (mode: ReaderViewDto['mode']): void => {
    const query = mode === 'vocab_assist' ? '?mode=vocab_assist' : '?mode=original';
    router.replace(`/materials/${view.materialId}/read${query}`, { scroll: false });
  };

  const scrollToChunk = (chunkId: string): void => {
    const element = document.getElementById(`chunk-${chunkId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(chunkId);
    setTimeout(() => setActiveId(null), HIGHLIGHT_MS);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => switchMode('original')}
            aria-pressed={view.mode === 'original'}
            className={`${BTN} ${
              view.mode === 'original'
                ? 'border-brand bg-brand text-white'
                : 'border-line bg-surface text-ink hover:bg-surfaceAlt'
            }`}
          >
            原文
          </button>
          <button
            type="button"
            onClick={() => switchMode('vocab_assist')}
            aria-pressed={view.mode === 'vocab_assist'}
            className={`${BTN} ${
              view.mode === 'vocab_assist'
                ? 'border-brand bg-brand text-white'
                : 'border-line bg-surface text-ink hover:bg-surfaceAlt'
            }`}
          >
            词汇辅助
          </button>
          {view.mode === 'vocab_assist' && <AiDerivedCallout note="仅标注已采纳的词条" />}
        </div>

        <p className="text-[11px] text-inkMuted">
          共 {view.chunks.length} 段
          {view.pageCount !== null ? ` · ${view.pageCount} 页` : ''}
          {` · 解析版本 v${view.docVersion}`}
        </p>
      </div>

      {view.injectionNotice && (
        <InjectionNotice
          affectedChunks={view.injectionNotice.affectedChunks}
          flags={view.injectionNotice.flags}
        />
      )}

      <div className="flex gap-4">
        {toc.length > 0 && (
          <nav
            aria-label="目录"
            className="sticky top-4 hidden max-h-[70vh] w-52 shrink-0 self-start overflow-y-auto rounded-lg border border-line bg-surface p-2 md:block"
          >
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-inkMuted">
              目录
            </p>
            <ul className="space-y-0.5">
              {toc.map((item) => (
                <li key={item.chunkId}>
                  <button
                    type="button"
                    onClick={() => scrollToChunk(item.chunkId)}
                    className="w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-ink hover:bg-surfaceAlt"
                    title={item.headingPath}
                  >
                    {item.headingPath}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="min-w-0 flex-1 space-y-2">
          {view.chunks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-xs text-inkMuted">
              这版解析没有产生任何内容块，请回到处理页重试解析。
            </p>
          ) : (
            view.chunks.map((chunk) => (
              <ChunkBlock
                key={chunk.id}
                chunk={chunk}
                active={activeId === chunk.id}
                materialId={view.materialId}
              />
            ))
          )}

          <p className="pt-1 text-[11px] text-inkMuted">
            原文按解析顺序逐段呈现。
            <Link
              href={`/materials/${view.materialId}/analysis`}
              className="ml-1 text-brand underline-offset-2 hover:underline"
            >
              查看 AI 分析审核
            </Link>
            {view.mode === 'vocab_assist' && (
              <Link
                href={`/materials/${view.materialId}/vocabulary`}
                className="ml-1 text-brand underline-offset-2 hover:underline"
              >
                审核词汇候选
              </Link>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
