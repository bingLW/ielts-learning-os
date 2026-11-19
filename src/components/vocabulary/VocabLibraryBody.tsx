'use client';

import { useRef, useState } from 'react';
import { archiveVocabDeckAction, commitVocabImportAction, createVocabDeckAction, previewVocabImportAction } from '@/lib/actions/vocabLibrary';
import type { VocabDeckDto, VocabImportPreview } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface VocabLibraryBodyProps {
  decks: VocabDeckDto[];
  deckItems: Record<string, Array<{ itemId: string; lemma: string; pos: string; definitionZh: string | null }>>;
}

const STATUS_LABEL: Record<string, string> = {
  NEW: '新增',
  DUPLICATE_IN_FILE: '文件内重复',
  EXISTS: '已存在',
  CONFLICT: '释义冲突',
  INVALID: '无效',
};

export function VocabLibraryBody({ decks, deckItems }: VocabLibraryBodyProps) {
  const { toast, show, dismiss } = useToastState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileText, setFileText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<VocabImportPreview | null>(null);
  const [deckId, setDeckId] = useState('');
  const [deckTitle, setDeckTitle] = useState('');
  const [includeConflicts, setIncludeConflicts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const onFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileText(await file.text());
    setPreview(null);
    if (!deckTitle) setDeckTitle(file.name.replace(/\.[^.]+$/, ''));
  };

  const runPreview = async () => {
    if (!fileText) {
      show('先选择一个 CSV / TSV / JSON 文件', 'error');
      return;
    }
    setBusy(true);
    const result = await previewVocabImportAction({ fileName, text: fileText });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    setPreview(result.data);
    show(`解析完成：共 ${result.data.total} 行`);
  };

  const runCommit = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await commitVocabImportAction({
      fileName,
      text: fileText,
      includeConflicts,
      deckId: deckId || undefined,
      deckTitle: deckId ? undefined : deckTitle || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    show(
      `导入完成：新增 ${result.data.created}，更新 ${result.data.updated}，跳过 ${result.data.skipped}`,
    );
    setPreview(null);
    setFileText('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const runCreateDeck = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    const result = await createVocabDeckAction({ title: newTitle.trim() });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    setNewTitle('');
    show('词库已创建');
  };

  const runArchive = async (deck: VocabDeckDto) => {
    if (!window.confirm(`归档词库「${deck.title}」？词条与历史会话都会保留，只是不再从它取计划候选。`)) {
      return;
    }
    const result = await archiveVocabDeckAction({ deckId: deck.id });
    if (!result.ok) show(result.error, 'error');
    else show('已归档');
  };

  return (
    <div className="space-y-3">
      <Card title="导入词表" description="先预览再写库；同形异义按 lemma + pos + senseKey 区分">
        <div className="grid gap-2 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            文件（CSV / TSV / JSON）
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json"
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              className="text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            导入到已有词库
            <select
              value={deckId}
              onChange={(event) => setDeckId(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="">（新建词库）</option>
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.title}（{deck.itemCount}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            新词库名称
            <input
              value={deckTitle}
              disabled={!!deckId}
              onChange={(event) => setDeckTitle(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink disabled:bg-surfaceAlt"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={runPreview} disabled={busy || !fileText}>
            解析并预览
          </Button>
          <label className="flex items-center gap-1 text-[11px] text-inkMuted">
            <input
              type="checkbox"
              checked={includeConflicts}
              onChange={(event) => setIncludeConflicts(event.target.checked)}
            />
            冲突行以文件为准更新释义
          </label>
        </div>

        {preview && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-inkMuted">
              格式 {preview.format} · 共 {preview.total} 行 ·
              {Object.entries(preview.counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => ` ${STATUS_LABEL[status] ?? status} ${count}`)
                .join(' ·')}
            </p>
            {preview.blockingErrors.length > 0 && (
              <ul className="list-disc pl-4 text-[11px] text-red-700">
                {preview.blockingErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            <div className="max-h-64 overflow-auto rounded border border-line">
              <table className="w-full text-[11px]">
                <thead className="bg-surfaceAlt text-inkMuted">
                  <tr>
                    <th className="px-2 py-1 text-left">行</th>
                    <th className="px-2 py-1 text-left">状态</th>
                    <th className="px-2 py-1 text-left">lemma</th>
                    <th className="px-2 py-1 text-left">pos</th>
                    <th className="px-2 py-1 text-left">释义</th>
                    <th className="px-2 py-1 text-left">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((row) => (
                    <tr key={row.line} className="border-t border-line">
                      <td className="px-2 py-1 tabular">{row.line}</td>
                      <td className="px-2 py-1">{STATUS_LABEL[row.status] ?? row.status}</td>
                      <td className="px-2 py-1">{row.item?.lemma ?? '—'}</td>
                      <td className="px-2 py-1">{row.item?.pos ?? '—'}</td>
                      <td className="px-2 py-1">{row.item?.definitionZh ?? '—'}</td>
                      <td className="px-2 py-1 text-inkMuted">{row.messages.join('；')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.truncated && (
              <p className="text-[11px] text-inkMuted">预览只显示前 200 行，确认导入会处理全部行。</p>
            )}
            <Button variant="primary" size="sm" onClick={runCommit} disabled={busy}>
              确认导入
            </Button>
          </div>
        )}
      </Card>

      <Card title="新建空词库" description="适合先建词库、再分多次导入">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            名称
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            />
          </label>
          <Button variant="secondary" size="sm" onClick={runCreateDeck} disabled={busy || !newTitle.trim()}>
            创建
          </Button>
        </div>
      </Card>

      <Card title={`词库（${decks.length}）`} description="归档不会删除词条或历史会话">
        {decks.length === 0 ? (
          <EmptyState
            icon="type"
            title="还没有词库"
            description="导入一个词表文件即可自动创建词库。"
          />
        ) : (
          <div className="space-y-2">
            {decks.map((deck) => (
              <div key={deck.id} className="rounded border border-line bg-white p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-ink">
                      {deck.title}{' '}
                      <span className="font-normal text-inkMuted">
                        · {deck.itemCount} 词 · 每日新词 {deck.dailyNewTarget} · 复习上限 {deck.reviewCap}
                      </span>
                    </p>
                    <p className="text-[11px] text-inkMuted">
                      状态 {deck.status}
                      {deck.targetStage ? ` · 阶段 ${deck.targetStage}` : ''}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void runArchive(deck)}>
                    归档
                  </Button>
                </div>
                {(deckItems[deck.id]?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[11px] text-inkMuted">
                    示例：
                    {(deckItems[deck.id] ?? [])
                      .slice(0, 8)
                      .map((item) => item.lemma)
                      .join('、')}
                    {deck.itemCount > 8 ? ' …' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
