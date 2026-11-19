'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { importTypeWordsBackupAction } from '@/lib/actions/vocabIntegration';
import { formatBusinessDateTime } from '@/lib/date';
import { readBackupArchiveText } from '@/lib/domain/backupArchive';
import type { VocabIntegrationJobDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface VocabSyncBodyProps {
  jobs: VocabIntegrationJobDto[];
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  running: '进行中',
  succeeded: '成功',
  partial: '部分成功',
  failed: '失败',
  retrying: '重试中',
};

const DIRECTION_LABEL: Record<string, string> = {
  EXPORT_DECK: '导出词库',
  IMPORT_BACKUP: '导入备份',
  IMPORT_SESSION: '导入会话',
};

export function VocabSyncBody({ jobs }: VocabSyncBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [countTime, setCountTime] = useState(true);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    try {
      setFileText(await readBackupArchiveText(await file.arrayBuffer()));
    } catch (error) {
      setFileText('');
      show(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const runImport = async () => {
    if (!fileText) {
      show('先选择一个 TypeWords 备份文件（.zip 或 .json）', 'error');
      return;
    }
    setBusy(true);
    const result = await importTypeWordsBackupAction({ fileName, text: fileText, countTime });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      router.refresh();
      return;
    }
    const summary = [
      `新增词条 ${result.data.wordsCreated}`,
      `跳过已有 ${result.data.wordsSkipped}`,
      `会话 ${result.data.sessionsImported}`,
      `重复会话 ${result.data.sessionsSkipped}`,
      `计入 ${result.data.minutesCounted} 分钟`,
    ].join(' · ');
    show(summary);
    if (result.data.warnings.length > 0) {
      show(result.data.warnings.join('；'), 'info');
    }
    setFileText('');
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <Card title="导入 TypeWords 备份" description="L1 文件交换：只读备份文件（zip 自动取 data.json），不连接对方浏览器或账号">
        <div className="grid gap-2 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
            备份文件（设置页导出的 .zip，或其中的 data.json）
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.json,application/zip,application/json"
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              className="text-xs"
            />
          </label>
          <label className="flex items-end gap-1 text-[11px] text-inkMuted">
            <input
              type="checkbox"
              checked={countTime}
              onChange={(event) => setCountTime(event.target.checked)}
            />
            把汇总会话计入学习时长（默认开启；与已有记录重叠的区间自动扣除）
          </label>
        </div>
        <div className="mt-2">
          <Button variant="primary" size="sm" onClick={runImport} disabled={busy || !fileText}>
            导入备份
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-inkMuted">
          固定版本只提供汇总统计（总词数 / 新词 / 复习 / 错误数），没有逐词尝试日志，
          因此导入的会话都是 SUMMARY_ONLY，不会推进七维掌握。
        </p>
      </Card>

      <Card title={`同步任务（${jobs.length}）`} description="每次导入/导出都留一条审计记录；原始 payload 保存在任务里">
        {jobs.length === 0 ? (
          <p className="text-xs text-inkMuted">还没有同步任务。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-surfaceAlt text-inkMuted">
                <tr>
                  <th className="px-2 py-1 text-left">时间</th>
                  <th className="px-2 py-1 text-left">方向</th>
                  <th className="px-2 py-1 text-left">状态</th>
                  <th className="px-2 py-1 text-left">文件</th>
                  <th className="px-2 py-1 text-left">结果 / 错误</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t border-line">
                    <td className="px-2 py-1 tabular text-inkMuted">
                      {formatBusinessDateTime(job.createdAt)}
                    </td>
                    <td className="px-2 py-1">{DIRECTION_LABEL[job.direction] ?? job.direction}</td>
                    <td className="px-2 py-1">{STATUS_LABEL[job.status] ?? job.status}</td>
                    <td className="px-2 py-1 text-inkMuted">{job.fileName ?? '—'}</td>
                    <td className="px-2 py-1 text-inkMuted">
                      {job.errorReport ?? job.countsJson ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
