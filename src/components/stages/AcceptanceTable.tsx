'use client';

/**
 * 7 维度验收清单（就地编辑）。
 *
 * H2 前置条件在这里就被限制住：判为通过/未通过时，「我的实际结果」与「证据」必填
 * （服务端 zod 也会再拦一次，前端只是提前告知）。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { evaluateGateAction } from '@/lib/actions/gate';
import { updateAcceptanceItemAction } from '@/lib/actions/stages';
import { VERDICT_LABEL_ZH, VERDICTS } from '@/lib/constants';
import { today } from '@/lib/date';
import type { AcceptanceItemDto, Verdict } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';
import { StatusBadge } from '@/components/ui/StatusBadge';

export function AcceptanceTable({
  items,
  stageId,
  stageName,
  onToast,
}: {
  items: AcceptanceItemDto[];
  stageId: string;
  stageName: string;
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = items.find((item) => item.id === editingId) ?? null;

  const [myResult, setMyResult] = useState('');
  const [evidence, setEvidence] = useState('');
  const [verdict, setVerdict] = useState<Verdict>('PENDING');
  const [judgedAt, setJudgedAt] = useState(today());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const open = (item: AcceptanceItemDto) => {
    setEditingId(item.id);
    setMyResult(item.myResult ?? '');
    setEvidence(item.evidence ?? '');
    setVerdict(item.verdict);
    setJudgedAt(item.judgedAt ?? today());
    setFieldErrors({});
  };

  const save = () => {
    if (!editing) return;
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateAcceptanceItemAction({
        itemId: editing.id,
        myResult: myResult || undefined,
        evidence: evidence || undefined,
        verdict,
        judgedAt: verdict === 'PENDING' ? undefined : judgedAt,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      setEditingId(null);
      router.refresh();

      /*
       * 保存成功后立刻复核一次门禁（T34）：让用户在同一屏看到「这一笔结果对 H1/H2 有什么影响」，
       * 而不是靠自己去数。复核只读，返回 unmet 清单与 suggested 建议 ——
       * 即便全部满足也只提示「建议」，绝不自动切换阶段。
       */
      const gate = await evaluateGateAction({ stageId });
      if (!gate.ok) {
        onToast('验收项已更新（门禁复核失败，可点上方「重新评估」重试）', 'success');
        return;
      }
      onToast(
        gate.data.suggested
          ? '验收项已更新：硬条件已全部满足（系统仅建议升级，需你手动确认）'
          : `验收项已更新：仍有 ${gate.data.unmet.length} 项硬条件未满足`,
        'success',
      );
    });
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1.5 pr-2 font-medium">维度</th>
              <th className="py-1.5 pr-2 font-medium">标准（SOP 原文，只读）</th>
              <th className="py-1.5 pr-2 font-medium">我的实际结果</th>
              <th className="py-1.5 pr-2 font-medium">证据</th>
              <th className="py-1.5 pr-2 font-medium">判定</th>
              <th className="py-1.5 pr-2 font-medium">判定日期</th>
              <th className="py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-line align-top">
                <td className="whitespace-nowrap py-1.5 pr-2">
                  <span className="font-medium text-ink">{item.dimensionLabel}</span>
                  {item.isRequired && (
                    <span className="ml-1 text-[10px] text-red-600" title="H1 必验项">
                      必验
                    </span>
                  )}
                </td>
                <td className="max-w-[280px] py-1.5 pr-2 text-[11px] text-inkMuted">
                  {item.criterionText}
                </td>
                <td className="max-w-[180px] py-1.5 pr-2 text-[11px]">
                  {item.myResult ?? <span className="text-inkMuted">未填</span>}
                </td>
                <td className="max-w-[160px] py-1.5 pr-2 text-[11px]">
                  {item.evidence ?? <span className="text-inkMuted">未填</span>}
                </td>
                <td className="py-1.5 pr-2">
                  <StatusBadge status={item.verdict} />
                </td>
                <td className="tabular py-1.5 pr-2 text-[11px] text-inkMuted">
                  {item.judgedAt ?? '—'}
                </td>
                <td className="py-1.5">
                  <Button variant="secondary" size="sm" onClick={() => open(item)}>
                    填写
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="rounded-md border border-brand bg-blue-50 p-2.5">
          <p className="mb-1.5 text-xs font-semibold text-ink">
            填写验收项：{editing.dimensionLabel}（{stageName}）
          </p>
          <p className="mb-2 rounded border border-line bg-white px-2 py-1 text-[11px] text-inkMuted">
            标准：{editing.criterionText}
          </p>

          <div className="grid gap-2 sm:grid-cols-3">
            <FormField
              label="我的实际结果"
              htmlFor="acc-result"
              error={fieldErrors.myResult}
              className="sm:col-span-1"
            >
              <textarea
                id="acc-result"
                value={myResult}
                onChange={(event) => setMyResult(event.target.value)}
                placeholder="例如：听力材料 2 份，正确率 68%"
                className={textareaClass}
              />
            </FormField>
            <FormField label="证据（链接或文本）" htmlFor="acc-evidence" error={fieldErrors.evidence}>
              <textarea
                id="acc-evidence"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="文件路径 / 链接 / 录音说明"
                className={textareaClass}
              />
            </FormField>
            <div className="grid gap-2">
              <FormField label="判定" htmlFor="acc-verdict" error={fieldErrors.verdict}>
                <select
                  id="acc-verdict"
                  value={verdict}
                  onChange={(event) => setVerdict(event.target.value as Verdict)}
                  className={inputClass}
                >
                  {VERDICTS.map((item) => (
                    <option key={item} value={item}>
                      {VERDICT_LABEL_ZH[item]}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField
                label="判定日期"
                htmlFor="acc-judged"
                hint="必须落在本阶段区间内（H2）"
              >
                <input
                  id="acc-judged"
                  type="date"
                  value={judgedAt}
                  disabled={verdict === 'PENDING'}
                  onChange={(event) => setJudgedAt(event.target.value)}
                  className={inputClass}
                />
              </FormField>
            </div>
          </div>

          <div className="mt-2 flex gap-1.5">
            <Button variant="primary" size="sm" onClick={save} disabled={pending}>
              {pending ? '保存中…' : '保存验收项'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
