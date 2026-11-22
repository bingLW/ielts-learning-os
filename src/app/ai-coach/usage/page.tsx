/**
 * `/ai-coach/usage` AI Usage Dashboard。
 *
 * 只统计数据库里真实的调用日志；模拟调用成本为 0，单独标记。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { buttonClass } from '@/components/ui/Button';
import { AI_TURN_STATUS_LABELS_ZH } from '@/lib/constants';
import { getAiUsageData } from '@/lib/queries/tutor';

export const dynamic = 'force-dynamic';

export default async function AiUsagePage() {
  const data = await getAiUsageData(14);
  const maxCalls = Math.max(1, ...data.dailySeries.map((item) => item.calls));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">AI Usage Dashboard</h1>
          <p className="text-xs text-inkMuted">
            最近 {data.days} 天调用次数、Token、估算成本、时延与错误率。Token 为估算值（字符数 / 3）。
          </p>
        </div>
        <Link className={buttonClass('ghost', 'sm')} href="/ai-coach">
          ← 返回 AI Learning Coach
        </Link>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="调用次数" value={data.calls} hint={`会话总数 ${data.sessionCount}`} tone="plan" />
        <StatTile label="Token（输入+输出）" value={data.totalTokens.toLocaleString()} tone="neutral" />
        <StatTile
          label="估算成本"
          value={`$${data.totalCostUsd.toFixed(4)}`}
          hint="模拟调用成本为 0"
          tone="output"
        />
        <StatTile
          label="错误率"
          value={`${data.errorRate}%`}
          hint={`平均时延 ${data.avgLatencyMs} ms`}
          tone={data.errorRate > 20 ? 'warn' : 'actual'}
        />
      </div>

      <Card title="预算状态" description={`今日 ${data.budget.dailyPercent}% / 本月 ${data.budget.monthlyPercent}%`}>
        <div className="space-y-2">
          <div>
            <div className="mb-1 flex justify-between text-xs text-inkMuted">
              <span>今日</span>
              <span>
                {data.budget.dailyPercent}% / 预算 ${data.engine.setting.dailyBudgetUsd}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surfaceAlt">
              <div
                className={[
                  'h-full',
                  data.budget.state === 'EXCEEDED'
                    ? 'bg-red-500'
                    : data.budget.state === 'WARN'
                      ? 'bg-amber-500'
                      : 'bg-emerald-500',
                ].join(' ')}
                style={{ width: `${Math.min(100, data.budget.dailyPercent)}%` }}
              />
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-xs text-inkMuted">
              <span>本月</span>
              <span>
                {data.budget.monthlyPercent}% / 预算 ${data.engine.setting.monthlyBudgetUsd}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surfaceAlt">
              <div
                className="h-full bg-sky-500"
                style={{ width: `${Math.min(100, data.budget.monthlyPercent)}%` }}
              />
            </div>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-inkMuted">
          当前预算判定：{data.budget.state}；Provider：{data.engine.providerMode === 'mock' ? '模拟模型' : '外部模型'}（{data.engine.modelConfig.label}）。
        </p>
      </Card>

      <Card title="每日调用" description="灰色为调用次数；红色段为失败/拦截次数。">
        <div className="space-y-1">
          {data.dailySeries.map((item) => (
            <div key={item.date} className="flex items-center gap-2 text-[11px]">
              <span className="w-20 shrink-0 text-inkMuted">{item.date.slice(5)}</span>
              <div className="flex h-3 flex-1 overflow-hidden rounded bg-surfaceAlt">
                <div
                  className="h-full bg-sky-400"
                  style={{ width: `${(item.calls / maxCalls) * 100}%` }}
                />
                <div
                  className="h-full bg-red-400"
                  style={{ width: `${(item.errors / maxCalls) * 100}%` }}
                />
              </div>
              <span className="w-40 shrink-0 text-right text-inkMuted tabular">
                {item.calls} 次 · {item.inputTokens + item.outputTokens} tok · ${item.costUsd.toFixed(4)}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="状态分布">
          {data.statusBreakdown.length === 0 ? (
            <p className="text-xs text-inkMuted">暂无调用。</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {data.statusBreakdown.map((item) => (
                <li key={item.status} className="flex justify-between border-b border-line/60 pb-1">
                  <span>{AI_TURN_STATUS_LABELS_ZH[item.status] ?? item.status}</span>
                  <span className="tabular">{item.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="最近调用" description="不记录提示词全文与密钥；仅保留脱敏元数据。">
          {data.recentCalls.length === 0 ? (
            <p className="text-xs text-inkMuted">暂无调用。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-[11px]">
                <thead className="text-inkMuted">
                  <tr className="border-b border-line">
                    <th className="py-1 pr-2">时间</th>
                    <th className="py-1 pr-2">状态</th>
                    <th className="py-1 pr-2">Token</th>
                    <th className="py-1 pr-2">时延</th>
                    <th className="py-1">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentCalls.map((log) => (
                    <tr key={log.id} className="border-b border-line/60">
                      <td className="py-1 pr-2 text-inkMuted">
                        {log.createdAt.toLocaleString('zh-CN')}
                      </td>
                      <td className="py-1 pr-2" title={log.errorCode ?? undefined}>
                        {AI_TURN_STATUS_LABELS_ZH[log.status] ?? log.status}
                      </td>
                      <td className="py-1 pr-2 tabular">{log.inputTokens + log.outputTokens}</td>
                      <td className="py-1 pr-2 tabular">{log.latencyMs} ms</td>
                      <td className="py-1 tabular">${log.estimatedCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}