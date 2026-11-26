/**
 * 决策轨迹：七个因子 × 权重 → 加权总分 → 终判 P 级。
 *
 * 轨迹必须**完整反演**评分：权重与因子值并排给出，用户才能自己乘一遍核对。
 * 因子缺失时显示「未记录」而不是补 0 —— 补 0 会让「没算过」看起来像「算出来很低」。
 */

import { DEFAULT_WEIGHTS, FACTOR_LABEL_ZH } from '@/lib/domain/taskPriority';
import { PRIORITY_FACTOR_KEYS } from '@/lib/constants';
import type { CandidateRowDto } from '@/lib/queries/planner';

export function DecisionTrace({ row }: { row: CandidateRowDto }) {
  const decision = row.decision;
  if (!decision) {
    return (
      <p className="text-[11px] text-inkMuted">
        该候选没有落库的决策轨迹（未进入评分阶段，例如被前置条件直接排除）。
      </p>
    );
  }

  const factors = decision.factors;

  return (
    <div className="space-y-1 text-[11px]">
      <p className="text-inkMuted">
        权重版本 {decision.weightsVersion}（权重为编译期常量，Σ = 1）· 加权总分{' '}
        <span className="tabular font-medium text-ink">{decision.score.toFixed(4)}</span> · 终判{' '}
        <span className="font-medium text-ink">{decision.priorityLabel}（{decision.priority}）</span>
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left text-[10px] text-inkMuted">
            <th className="py-1 pr-2 font-medium">因子</th>
            <th className="py-1 pr-2 font-medium">权重</th>
            <th className="py-1 pr-2 font-medium">因子值</th>
            <th className="py-1 font-medium">加权贡献</th>
          </tr>
        </thead>
        <tbody>
          {PRIORITY_FACTOR_KEYS.map((key) => {
            const weight = DEFAULT_WEIGHTS[key];
            const value = factors?.[key];
            return (
              <tr key={key} className="border-b border-line/60">
                <td className="py-0.5 pr-2 text-ink">{FACTOR_LABEL_ZH[key]}</td>
                <td className="tabular py-0.5 pr-2 text-inkMuted">{weight.toFixed(2)}</td>
                <td className="tabular py-0.5 pr-2 text-ink">
                  {typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '未记录'}
                </td>
                <td className="tabular py-0.5 text-inkMuted">
                  {typeof value === 'number' && Number.isFinite(value) ? (value * weight).toFixed(4) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-inkMuted">判定依据：{decision.rationale}</p>
      <p className="text-inkMuted">
        若不做的后果：{decision.consequenceIfSkipped ?? '无法判断（系统不编造）'}
      </p>
      {decision.noObservation && (
        <p className="text-amber-800">近 28 天该维度没有观察记录：错误重复度按 0 计，不等于「确认没有重复错误」。</p>
      )}
    </div>
  );
}