'use client';

/**
 * 处理状态页主体：轮询驱动状态机。
 *
 * 轮询策略（ADR-05）：
 * - 立即打一次 tick（用户刚导入完，不该先干等 3 秒）；
 * - 之后每 `MATERIAL_LIMITS.pollIntervalMs`（3s）一次，直到 `polling === false`；
 * - 组件卸载 / 到达终态立刻停表，不再发请求；
 * - 单次失败不清空已有状态（网络抖动不该让页面变成空白），只提示一次。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/Button';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { cancelMaterialJobAction, retryMaterialJobAction } from '@/lib/actions/materials';
import { MATERIAL_LIMITS, MATERIAL_STATUS_LABELS_ZH } from '@/lib/constants';
import type { MaterialHeaderDto, MaterialStatusDto } from '@/lib/queries/materials';
import { MaterialStatusBadge, RestrictedSourceWarning } from './MaterialStatusBadge';
import { PartialDetailPanel } from './PartialDetailPanel';
import { StageProgress } from './StageProgress';

export function ProcessingStatusBody({
  initial,
  header,
}: {
  initial: MaterialStatusDto;
  header: MaterialHeaderDto | null;
}) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [status, setStatus] = useState<MaterialStatusDto>(initial);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const alive = useRef(true);

  const tick = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/materials/${initial.materialId}/tick`, {
        method: 'POST',
        cache: 'no-store',
      });
      const payload = (await response.json()) as
        | { ok: true; data: MaterialStatusDto }
        | { ok: false; code: string; error: string };
      if (!alive.current) return;
      if (payload.ok) {
        setStatus(payload.data);
        setPollError(null);
      } else {
        setPollError(payload.error);
      }
    } catch {
      if (!alive.current) return;
      setPollError('与服务器通信失败，正在重试…');
    }
  }, [initial.materialId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 轮询：立即一次 + 每次结束后按间隔排下一次（避免请求堆叠）
  useEffect(() => {
    if (!status.polling) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const run = async (): Promise<void> => {
      await tick();
      if (cancelled) return;
      timer = setTimeout(run, MATERIAL_LIMITS.pollIntervalMs);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [status.polling, tick]);

  // 到达终态时刷新服务端数据（列表/详情依赖的状态已变）
  useEffect(() => {
    if (!status.polling) router.refresh();
  }, [status.polling, router]);

  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await cancelMaterialJobAction({ materialId: status.materialId });
      setConfirmCancel(false);
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('已请求取消，正在安全收尾…', 'info');
      await tick();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await retryMaterialJobAction({ materialId: status.materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(`已重新排队（第 ${result.data.attempt} 次），从「${result.data.fromStage}」续跑`);
      await tick();
    } finally {
      setBusy(false);
    }
  };

  const terminal = !status.polling;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="truncate text-base font-semibold text-ink">{status.title}</h1>
            <MaterialStatusBadge status={status.status} />
            {header?.restrictedSource && <RestrictedSourceWarning sourceTypeLabel={header.sourceTypeLabel} />}
          </div>
          <p className="mt-0.5 text-xs text-inkMuted">
            {status.formatLabel}
            {header ? ` · ${header.sourceTypeLabel} · ${header.charCount.toLocaleString()} 字符` : ''}
            {status.stageLabel ? ` · 当前阶段：${status.stageLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href="/materials" className={buttonClass('ghost', 'sm')}>
            返回材料库
          </Link>
          {status.retryable && (
            <Button size="sm" variant="primary" onClick={retry} disabled={busy}>
              <Icon name="repeat" size={13} />
              重试
            </Button>
          )}
          {status.cancellable && (
            <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)} disabled={busy}>
              取消处理
            </Button>
          )}
        </div>
      </div>

      <Card
        title="处理进度"
        description={
          status.polling
            ? `每 ${MATERIAL_LIMITS.pollIntervalMs / 1000} 秒自动刷新 · 关闭页面不会中断处理`
            : '处理已结束'
        }
      >
        <StageProgress stages={status.stages} current={status.stage} />

        <div className="mt-3 grid gap-1 text-[11px] text-inkMuted sm:grid-cols-2">
          <span>
            当前单元：{status.progress.unitLabel} {status.progress.done} / {status.progress.total}
            {/* 跳过数必须同行显示：`done === total` 但产出为 0 时，只说「批次 4 / 4」
                会让用户以为系统算错了（T12 §7.1） */}
            {status.progress.skipped > 0
              ? `（其中 ${status.progress.skipped} 个单元此前已处理过，本轮跳过）`
              : ''}
          </span>
          <span>状态：{status.statusLabel}</span>
          {/* 成本可见性：单次运行上限 60 次，累计值必须一直看得见 */}
          <span className="sm:col-span-2">
            本材料累计 AI 调用 {status.aiUsage.calls} 次 · 预估 $
            {status.aiUsage.estimatedCostUsd.toFixed(4)}
            {` · 单次运行上限 ${MATERIAL_LIMITS.maxAiCalls} 次`}
          </span>
        </div>

        {status.statusReason && (
          <p className="mt-2 rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-ink">
            {status.statusReason}
          </p>
        )}

        {status.error && (
          <div className="mt-2 rounded-md border border-egRed/40 bg-egRed/10 p-2">
            <p className="text-xs font-semibold text-egRed">处理失败</p>
            <p className="mt-0.5 text-[11px] text-ink">{status.error.message}</p>
            <p className="mt-0.5 font-mono text-[10px] text-inkMuted">code: {status.error.code}</p>
            <p className="mt-1 text-[11px] text-inkMuted">
              重试不会重新上传文件（原文仍在本地），会从失败的阶段继续。
            </p>
          </div>
        )}

        {pollError && status.polling && (
          <p role="status" className="mt-2 text-[11px] text-egYellow">
            {pollError}
          </p>
        )}
      </Card>

      <PartialDetailPanel status={status} />

      {terminal && status.status !== 'failed' && (
        <Card title="下一步" description="解析完成后，可以在这里进入原文阅读与 AI 分析审核。">
          <p className="text-[11px] leading-relaxed text-inkMuted">
            {status.status === 'review_required'
              ? '正文与 AI 分析结果都已就绪。逐条审核完 AI 结果后，材料才会进入可用状态。'
              : status.status === 'partial'
                ? '已按可用部分完成处理。你可以继续使用已解析内容，也可以追加一轮额度继续分析。'
                : status.status === 'ready'
                  ? '这份材料的 AI 结果已全部审核完成，可以正常使用。'
                  : `材料状态：${MATERIAL_STATUS_LABELS_ZH[status.status]}。`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Link
              href={`/materials/${status.materialId}/read`}
              className={buttonClass('primary', 'sm')}
            >
              阅读原文
            </Link>
            <Link
              href={`/materials/${status.materialId}/analysis`}
              className={buttonClass('secondary', 'sm')}
            >
              审核 AI 分析
            </Link>
            <Link href="/materials" className={buttonClass('ghost', 'sm')}>
              查看材料库
            </Link>
            <Link href="/materials/import" className={buttonClass('ghost', 'sm')}>
              再导入一份
            </Link>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="取消这次处理？"
        description="已完成的解析结果会保留；取消后不再继续占用 AI 调用额度。该操作不可撤销（可以重新导入）。"
        confirmLabel="确认取消"
        danger
        busy={busy}
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
