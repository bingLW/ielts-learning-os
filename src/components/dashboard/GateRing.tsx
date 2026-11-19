/**
 * Dashboard ⑩ 下一阶段验收完成度：进度环 + 未通过项名称。
 */

import Link from 'next/link';
import { formatPercent } from '@/lib/format';
import type { GatePanelDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';

const SIZE = 72;
const STROKE = 8;

export function GateRing({ data }: { data: GatePanelDto | null }) {
  if (!data) {
    return (
      <Card title="阶段验收完成度">
        <p className="text-xs text-inkMuted">尚未激活阶段。</p>
      </Card>
    );
  }

  const { requiredPassed, requiredTotal } = data.gate.metrics;
  const ratio = requiredTotal === 0 ? 0 : requiredPassed / requiredTotal;
  const radius = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * Math.min(1, Math.max(0, ratio));

  return (
    <Card
      title="阶段验收完成度"
      description={data.stageName}
      actions={
        <Link href="/stages" className="text-[11px] text-brand hover:underline">
          去验收 →
        </Link>
      }
    >
      <div className="flex items-center gap-3">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`必验项通过 ${requiredPassed}/${requiredTotal}`}
          className="shrink-0"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={radius}
            fill="none"
            stroke="var(--color-line)"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={radius}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth={STROKE}
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
          <text
            x="50%"
            y="52%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="tabular"
            fontSize="14"
            fill="var(--color-ink)"
          >
            {requiredPassed}/{requiredTotal}
          </text>
        </svg>

        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink">
            必验项通过率 <b className="tabular">{formatPercent(ratio)}</b>
          </p>
          <p className="text-[11px] text-inkMuted">
            {data.gate.suggested ? '硬条件已全部满足，可手动确认升级' : `未满足 ${data.gate.unmet.length} 项硬条件`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {data.gate.unmet.slice(0, 4).map((item) => (
              <li key={item.code} className="flex items-center gap-1 text-[11px] text-amber-800">
                <Icon name="alert" size={10} />
                {item.code} · {item.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
