'use client';

/**
 * 升级判定区。
 *
 * 行为约束（PRD P0-03 / §6.4）：
 * - 硬条件不满足 → 「建议升级」按钮禁用，并逐条列出未满足项与差距；
 * - 即使满足，系统也只给**建议**，实际切换必须由用户点击并填写 ≥10 字原因；
 * - 每次切换写 `StageTransitionLog`（时间 + 原因 + 证据快照），只增不删。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { evaluateGateAction } from '@/lib/actions/gate';
import { transitionStageAction } from '@/lib/actions/stages';
import { TRANSITION_REASON_MIN_LENGTH } from '@/lib/constants';
import { formatPercent } from '@/lib/format';
import type { GateResult } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface GatePanelProps {
  gate: GateResult | null;
  stageId: string;
  stageName: string;
  otherStages: { id: string; nameZh: string }[];
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function GatePanel({ gate, stageId, stageName, otherStages, onToast }: GatePanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rechecking, startRecheck] = useTransition();
  const [open, setOpen] = useState(false);
  const [toStageId, setToStageId] = useState(otherStages[0]?.id ?? '');
  const [reason, setReason] = useState('');

  const suggested = gate?.suggested ?? false;

  /**
   * 重新评估门禁（T34）。
   *
   * 只读复核：调 `evaluateGateAction` 拿最新的 H1–H5 结论，把结论直接说给用户听，
   * 然后 `router.refresh()` 让页面用同一份服务端结果重渲染。
   * **不**在这里写任何阶段状态 —— 升级必须由用户点「手动调整阶段」并填原因。
   */
  const recheck = () => {
    startRecheck(async () => {
      const result = await evaluateGateAction({ stageId });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      const { suggested: ok, unmet } = result.data;
      onToast(
        ok
          ? '门禁复核完成：硬条件全部满足（系统仅建议，不会自动切换阶段）'
          : `门禁复核完成：仍有 ${unmet.length} 项硬条件未满足`,
        'success',
      );
      router.refresh();
    });
  };

  const submit = () => {
    if (reason.trim().length < TRANSITION_REASON_MIN_LENGTH) {
      onToast(`升级原因至少 ${TRANSITION_REASON_MIN_LENGTH} 个字`, 'error');
      return;
    }
    if (!toStageId) {
      onToast('请选择目标阶段', 'error');
      return;
    }
    startTransition(async () => {
      const result = await transitionStageAction({ toStageId, reason, fromStageId: stageId });
      setOpen(false);
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('阶段已切换，并写入流转日志', 'success');
      router.refresh();
    });
  };

  return (
    <Card
      title="升级判定（H1–H5 硬条件）"
      description="系统只给建议，永不自动切换阶段。「重新评估」是只读复核，不写任何状态。"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={recheck}
            disabled={rechecking}
            title="只读复核 H1–H5，不会改动任何阶段状态"
          >
            <Icon name="repeat" size={12} />
            {rechecking ? '复核中…' : '重新评估'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!suggested}
            onClick={() => setOpen(true)}
            title={
              suggested
                ? '硬条件全部满足：点击后仍需你填写原因并确认，系统不会自动切换'
                : '存在未满足的硬条件'
            }
          >
            <Icon name="flag" size={12} />
            {suggested ? '建议升级（需手动确认）' : '暂不满足升级条件'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            手动调整阶段
          </Button>
        </div>
      }
    >
      {!gate ? (
        <p className="text-xs text-inkMuted">没有可判定的阶段数据。</p>
      ) : (
        <>
          <div className="mb-2 grid gap-1.5 text-[11px] sm:grid-cols-2 xl:grid-cols-3">
            <p className="rounded border border-line bg-surfaceAlt px-2 py-1">
              H1 必验通过：
              <b className="tabular">
                {gate.metrics.requiredPassed}/{gate.metrics.requiredTotal}
              </b>
            </p>
            <p className="rounded border border-line bg-surfaceAlt px-2 py-1">
              H3 近 14 天 D7/D14 完成率：
              <b className="tabular">{formatPercent(gate.metrics.h3Rate)}</b>
            </p>
            <p className="rounded border border-line bg-surfaceAlt px-2 py-1">
              H4 近 30 天达标占比：
              <b className="tabular">{formatPercent(gate.metrics.h4Rate)}</b>
            </p>
            <p className="rounded border border-line bg-surfaceAlt px-2 py-1">
              H5 未处理红灯：<b className="tabular">{gate.metrics.redLessons}</b> 个
            </p>
            <p className="rounded border border-line bg-surfaceAlt px-2 py-1">
              结论：
              <b className={suggested ? 'text-emerald-700' : 'text-amber-800'}>
                {suggested ? '建议升级' : `未满足 ${gate.unmet.length} 项`}
              </b>
            </p>
          </div>

          {gate.unmet.length > 0 ? (
            <ul className="space-y-1">
              {gate.unmet.map((item) => (
                <li
                  key={item.code}
                  className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
                >
                  <b>{item.code}</b> · {item.label}
                  <span className="ml-1 text-amber-800">当前：{item.current}</span>
                  <span className="ml-1">目标：{item.target}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
              全部硬条件满足。请自行确认是否进入下一阶段 —— 系统不会替你决定。
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={open}
        title="手动调整阶段"
        description={
          <div className="space-y-2">
            <p>
              当前阶段：<b>{stageName}</b>。切换会写入流转日志（时间 + 原因 + 证据快照），历史不可删除。
            </p>
            <FormField label="目标阶段" htmlFor="to-stage" required>
              <select
                id="to-stage"
                value={toStageId}
                onChange={(event) => setToStageId(event.target.value)}
                className={inputClass}
              >
                {otherStages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.nameZh}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label={`原因（至少 ${TRANSITION_REASON_MIN_LENGTH} 字）`}
              htmlFor="transition-reason"
              required
            >
              <textarea
                id="transition-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：S1 必验项 5/5 通过，但口语仍不稳，先进入 S2 边练边补"
                className={textareaClass}
              />
            </FormField>
          </div>
        }
        confirmLabel={pending ? '处理中…' : '确认切换'}
        danger={false}
        busy={pending}
        onCancel={() => setOpen(false)}
        onConfirm={submit}
      />
    </Card>
  );
}
