/**
 * 五维证据矩阵（PRD §4.9②）。
 *
 * 每维一行：状态三态（✓ / ✗ / 数据不足）+ 说明 + 依据条数。
 * 状态来自评审快照原文，不在这里重新判断。
 */

import type { ReadinessDimensionRowDto } from '@/lib/queries/planner';

const STATUS_META: Record<
  ReadinessDimensionRowDto['status'],
  { icon: string; label: string; tone: string }
> = {
  PASS: { icon: '✓', label: '通过', tone: 'text-green-700' },
  FAIL: { icon: '✗', label: '未通过', tone: 'text-red-700' },
  INSUFFICIENT: { icon: '—', label: '数据不足', tone: 'text-amber-700' },
  READ_ERROR: { icon: '!', label: '数据读取失败', tone: 'text-red-800' },
};

export function FiveDimensionMatrix({ dimensions }: { dimensions: ReadinessDimensionRowDto[] }) {
  if (dimensions.length === 0) {
    return (
      <p data-testid="readiness-dimensions-empty" className="text-[11px] text-inkMuted">
        还没有五维明细。生成评审后，这里会列出五个维度各自的证据状态。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table data-testid="readiness-dimensions" className="w-full min-w-[520px] text-[11px]">
        <thead>
          <tr className="border-b border-line text-inkMuted">
            <th className="py-1 text-left font-medium">维度</th>
            <th className="py-1 text-left font-medium">状态</th>
            <th className="py-1 text-left font-medium">依据</th>
            <th className="py-1 text-right font-medium">证据条数</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((row) => {
            const meta = STATUS_META[row.status] ?? STATUS_META.INSUFFICIENT;
            return (
              <tr key={row.code} className="border-b border-line/60" data-status={row.status}>
                <td className="py-1">
                  <span className="font-medium text-ink">{row.label}</span>
                  <span className="ml-1 text-inkMuted">{row.code}</span>
                </td>
                <td className={`py-1 font-medium ${meta.tone}`}>
                  {meta.icon} {meta.label}
                </td>
                <td className="py-1 text-inkMuted">{row.detail}</td>
                <td className="py-1 text-right tabular">{row.evidenceRefs.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}