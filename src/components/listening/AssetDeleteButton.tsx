'use client';

/** 两步资产删除：先看影响预览，再输入明确确认；服务端事务是最终权限/引用边界。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { previewAudioAssetDeletionAction, confirmAssetDeletionAction } from '@/lib/actions/listening';

interface PreviewData {
  preview: {
    affected: Record<string, number>;
    references: Array<{ model: string; id: string }>;
  };
  previewToken: string;
}

const LABELS: Record<string, string> = {
  transcripts: '转写',
  transcriptSegments: '转写片段',
  listeningExercises: '听力练习',
  listeningAttempts: '听力作答',
  listeningErrors: '听力错误',
  speakingSessions: '关联口语会话',
  speakingTurns: '口语轮次',
  asrResults: '语音识别结果',
  speechEvaluations: '口语评分',
  audioTechnicalChecks: '技术检查',
};

export function AssetDeleteButton({ kind, assetId, title }: { kind: 'audio' | 'recording'; assetId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [references, setReferences] = useState<Array<{ model: string; id: string }>>([]);

  const loadPreview = async () => {
    setBusy(true);
    setMessage(null);
    setReferences([]);
    const result = await previewAudioAssetDeletionAction({ kind, assetId, reason });
    setBusy(false);
    if (!result.ok) {
      setMessage(`${result.code}: ${result.error}`);
      setReferences(result.references ?? []);
      return;
    }
    setPreview(result.data);
  };

  const remove = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    const result = await confirmAssetDeletionAction({
      kind,
      assetId,
      reason,
      confirmation,
      previewToken: preview.previewToken,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(`${result.code}: ${result.error}`);
      setReferences(result.references ?? []);
      if (result.code === 'CONFLICT') setPreview(null);
      return;
    }
    setOpen(false);
    setMessage('已软删除：历史记录与本地文件均保留，播放和活跃列表不再显示。');
    router.refresh();
  };

  return (
    <div className="mt-2 border-t border-ink/10 pt-2">
      <button
        type="button"
        className="text-xs text-egRed hover:underline disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setOpen((value) => !value);
          setPreview(null);
          setConfirmation('');
          setMessage(null);
          setReferences([]);
        }}
      >
        {open ? '取消删除' : '删除资产'}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-egRed/20 bg-egRed/5 p-3 text-xs">
          <p className="font-medium text-ink">删除“{title}”？</p>
          <p className="mt-1 text-inkMuted">采用软删除/tombstone，不删数据库历史行和本地文件；删除后不可从播放器或活跃列表访问。</p>
          <label className="mt-2 block text-inkMuted">
            删除原因
            <input
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setPreview(null);
                setConfirmation('');
              }}
              maxLength={500}
              className="mt-1 w-full rounded border border-ink/15 bg-white px-2 py-1 text-ink"
              placeholder="例如：不再使用这段材料"
            />
          </label>
          <button
            type="button"
            onClick={() => void loadPreview()}
            disabled={busy || !reason.trim()}
            className="mt-2 rounded border border-ink/20 px-2 py-1 text-ink disabled:opacity-50"
          >
            {busy ? '检查中…' : '预览影响'}
          </button>
          {preview && (
            <div className="mt-3">
              <p className="font-medium text-ink">将保留以下关联记录：</p>
              <ul className="mt-1 list-inside list-disc text-inkMuted">
                {Object.entries(preview.preview.affected).filter(([, count]) => count > 0).map(([key, count]) => (
                  <li key={key}>{LABELS[key] ?? key}：{count} 条</li>
                ))}
                {Object.values(preview.preview.affected).every((count) => count === 0) && <li>无子记录</li>}
              </ul>
              {preview.preview.references.length > 0 ? (
                <p className="mt-2 font-medium text-egRed">资源仍被证据/诊断/材料/计划引用，已阻止删除。请先处理引用：</p>
              ) : (
                <label className="mt-3 block text-inkMuted">
                  二次确认：输入“确认删除”
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    className="mt-1 w-full rounded border border-ink/15 bg-white px-2 py-1 text-ink"
                    autoComplete="off"
                  />
                </label>
              )}
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy || confirmation !== '确认删除' || preview.preview.references.length > 0}
                className="mt-2 rounded bg-egRed px-2 py-1 text-white disabled:opacity-40"
              >
                确认软删除
              </button>
            </div>
          )}
          {(references.length > 0 || preview?.preview.references.length) && (
            <ul className="mt-2 max-h-32 overflow-auto font-mono text-[10px] text-egRed">
              {(references.length ? references : preview?.preview.references ?? []).map((reference) => (
                <li key={`${reference.model}:${reference.id}`}>{reference.model}: {reference.id}</li>
              ))}
            </ul>
          )}
          {message && <p role="status" className="mt-2 text-inkMuted">{message}</p>}
        </div>
      )}
    </div>
  );
}
