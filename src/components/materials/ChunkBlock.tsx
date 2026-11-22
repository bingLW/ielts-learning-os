'use client';

/**
 * 原文的一个内容块。
 *
 * 两条铁律：
 * 1. **原文逐字渲染**：`chunk.text` 原样输出（`whitespace-pre-wrap`），
 *    不 trim、不折叠空白、不重新断句 —— 学生看到的就是文件里的字；
 * 2. **原创模式下不接收任何 AI 字段**：`hints` 恒为空数组（查询层保证），
 *    本组件也不会去拿"没有被传进来的东西"。
 *
 * 词汇高亮的切片规则：按起点排序后**跳过重叠**的后一条 —— 重叠高亮在视觉上
 * 会互相切断，比少显示一条更糟。
 */

import {
  MATERIAL_SUSPICION_FLAG_LABELS_ZH,
  type MaterialSuspicionFlag,
} from '@/lib/constants';
import type { ReaderChunkDto, VocabHintDto } from '@/lib/queries/materials';
import { VocabHoverCard } from './VocabHoverCard';

export interface ChunkBlockProps {
  chunk: ReaderChunkDto;
  /** 是否高亮（从 TOC / 分析页跳转过来时的定位闪烁）。 */
  active?: boolean;
  /** 材料 id：词汇气泡要用它拼「去审核这条候选」的链接（T12）。 */
  materialId: string;
}

interface Segment {
  key: string;
  text: string;
  hint?: VocabHintDto;
}

/** 把正文切成「普通文本 / 词汇命中」片段（重叠的命中直接丢弃）。 */
export function buildSegments(text: string, hints: readonly VocabHintDto[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const hint of hints) {
    if (hint.start < cursor) continue; // 与前一条重叠 → 丢弃
    if (hint.start >= text.length) break;
    const end = Math.min(hint.end, text.length);
    if (end <= hint.start) continue;

    if (hint.start > cursor) {
      segments.push({ key: `t${cursor}`, text: text.slice(cursor, hint.start) });
    }
    segments.push({ key: `h${hint.extractionId}`, text: text.slice(hint.start, end), hint });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ key: `t${cursor}`, text: text.slice(cursor) });
  return segments;
}

/** chunk 的位置标签（页码 / 段号 / 标题路径，有哪个显示哪个）。 */
function locationLabel(chunk: ReaderChunkDto): string {
  const parts: string[] = [`#${chunk.seq}`];
  if (chunk.page !== null) parts.push(`第 ${chunk.page} 页`);
  if (chunk.paragraphIndex !== null) parts.push(`第 ${chunk.paragraphIndex} 段`);
  return parts.join(' · ');
}

export function ChunkBlock({ chunk, active = false, materialId }: ChunkBlockProps) {
  const segments = buildSegments(chunk.text, chunk.hints);
  const flags: MaterialSuspicionFlag[] = chunk.suspicionFlags;

  return (
    <article
      id={`chunk-${chunk.id}`}
      className={[
        'scroll-mt-20 rounded-lg border bg-surface p-3 transition-shadow',
        active ? 'border-egYellow ring-2 ring-egYellow' : 'border-line',
      ].join(' ')}
    >
      <header className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-inkMuted">
        <span className="font-mono">{locationLabel(chunk)}</span>
        {chunk.headingPath && <span className="truncate">· {chunk.headingPath}</span>}
        {flags.length > 0 && (
          <span className="rounded border border-egYellow/60 bg-egYellow/10 px-1 py-0.5 text-egYellow">
            疑似注入：{flags.map((flag) => MATERIAL_SUSPICION_FLAG_LABELS_ZH[flag]).join('、')}
          </span>
        )}
      </header>

      <p className="whitespace-pre-wrap break-words text-[13px] leading-7 text-ink">
        {segments.map((segment) =>
          segment.hint ? (
            <VocabHoverCard
              key={segment.key}
              lemma={segment.hint.lemma}
              pos={segment.hint.pos}
              definitionZh={segment.hint.definitionZh}
              definitionSource={segment.hint.definitionSource}
              candidateId={segment.hint.candidateId}
              materialId={materialId}
            >
              {segment.text}
            </VocabHoverCard>
          ) : (
            <span key={segment.key}>{segment.text}</span>
          ),
        )}
      </p>
    </article>
  );
}
