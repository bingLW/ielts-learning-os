/**
 * 两版差异：三栏（模块 / 变更前 / 变更后），只比**计划分钟**。
 *
 * 实际分钟是已发生的事实，不随版本变化，所以这里不出现实际列 —— 否则用户会
 * 把「实际没变」误读成「版本没有差异」。
 */

import type { VersionDiffDto } from '@/lib/queries/planner';

const LAYER_LABEL: Record<string, string> = {
  DAY: '日计划',
  WEEK: '周计划',
  MONTH: '月计划',
  CYCLE: '90 天周期',
};

function deltaText(delta: number): string {
  if (delta === 0) return '±0';
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export function VersionDiffView({ diff }: { diff: VersionDiffDto | null }) {
  if (!diff) {
    return (
      <p data-testid="version-diff-empty" className="text-xs text-inkMuted">
        还没有可对比的两个版本：在左侧时间线分别点「设为基准」与「设为对照」。
      </p>
    );
  }

  const totalBefore = diff.rows.reduce((sum, row) => sum + row.beforeMinutes, 0);
  const totalAfter = diff.rows.reduce((sum, row) => sum + row.afterMinutes, 0);

  return (
    <div data-testid="version-diff" className="space-y-2">
      <p className="text-[11px] text-inkMuted">
        基准 v{diff.before.version}（{LAYER_LABEL[diff.before.layer] ?? diff.before.layer} ·{' '}
        {diff.before.planDate}） → 对照 v{diff.after.version}（
        {LAYER_LABEL[diff.after.layer] ?? diff.after.layer} · {diff.after.planDate}）
      </p>

      {diff.rows.length === 0 ? (
        <p data-testid="version-diff-rows-empty" className="text-xs text-inkMuted">
          两版在各自计划周期内都没有已排任务，差异为空（不是相等，是两边都没排）。
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-inkMuted">
              <th className="py-1 pr-2 font-medium">模块</th>
              <th className="py-1 pr-2 text-right font-medium">变更前</th>
              <th className="py-1 text-right font-medium">变更后</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row) => (
              <tr
                key={row.module}
                data-testid="diff-row"
                data-module={row.module}
                data-before={row.beforeMinutes}
                data-after={row.afterMinutes}
                className="border-b border-line/60 last:border-0"
              >
                <td className="py-1 pr-2 text-ink">{row.moduleLabel}</td>
                <td className="py-1 pr-2 text-right text-ink">
                  {row.beforeMinutes} 分
                  <span className="ml-1 text-[10px] text-inkMuted">({row.beforeCount} 条)</span>
                </td>
                <td className="py-1 text-right text-ink">
                  {row.afterMinutes} 分
                  <span className="ml-1 text-[10px] text-inkMuted">({row.afterCount} 条)</span>
                  <span
                    className={[
                      'ml-1 text-[10px]',
                      row.deltaMinutes > 0
                        ? 'text-amber-700'
                        : row.deltaMinutes < 0
                          ? 'text-emerald-700'
                          : 'text-inkMuted',
                    ].join(' ')}
                  >
                    {deltaText(row.deltaMinutes)}
                  </span>
                </td>
              </tr>
            ))}
            <tr className="text-xs font-medium text-ink">
              <td className="py-1 pr-2">合计</td>
              <td className="py-1 pr-2 text-right">{totalBefore} 分</td>
              <td className="py-1 text-right">
                {totalAfter} 分
                <span className="ml-1 text-[10px] text-inkMuted">
                  {deltaText(totalAfter - totalBefore)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}