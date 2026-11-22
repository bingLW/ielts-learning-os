/**
 * `/ai-coach/review` Evidence Review：对比基线、辅助与复测。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonClass } from '@/components/ui/Button';
import {
  ASSESSOR_TYPE_LABEL_ZH,
  ASSISTANCE_LEVEL_LABEL_ZH,
  AI_COACH_MODE_LABEL_ZH,
  AI_SESSION_STATUS_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  type AiSessionStatus,
} from '@/lib/constants';
import { listAiEvidenceRows, listAiReviewSessions } from '@/lib/queries/tutor';

export const dynamic = 'force-dynamic';

const TYPE_LABEL = LEARNING_EVIDENCE_TYPE_LABEL_ZH as Record<string, string>;
const ASSESSOR_LABEL = ASSESSOR_TYPE_LABEL_ZH as Record<string, string>;
const LEVEL_LABEL = ASSISTANCE_LEVEL_LABEL_ZH as Record<string, string>;

export default async function AiReviewPage() {
  const [sessions, rows] = await Promise.all([listAiReviewSessions(), listAiEvidenceRows()]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">Evidence Review</h1>
          <p className="text-xs text-inkMuted">
            同一会话内的 Baseline / Assisted / Immediate Retest 分列保存；辅助表现不计入独立证据。
          </p>
        </div>
        <Link className={buttonClass('ghost', 'sm')} href="/ai-coach">
          ← 返回 AI Learning Coach
        </Link>
      </header>

      {sessions.length === 0 ? (
        <EmptyState
          title="还没有 AI 会话证据"
          description="先完成一次会话的基线与复测，这里会出现可对比的证据链。"
          icon="chart"
        />
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => {
            const baseline = session.evidence.find((item) => item.evidenceType === 'BASELINE');
            const retest = session.evidence.find(
              (item) => item.evidenceType === 'IMMEDIATE_RETEST',
            );
            return (
              <Card
                key={session.id}
                title={session.objective}
                description={`${AI_COACH_MODE_LABEL_ZH[session.mode as keyof typeof AI_COACH_MODE_LABEL_ZH] ?? session.mode} · ${session.skill} · ${
                  AI_SESSION_STATUS_LABEL_ZH[session.status as AiSessionStatus] ?? session.status
                }`}
                actions={
                  <Link className={buttonClass('secondary', 'sm')} href={`/ai-coach/${session.id}`}>
                    打开会话
                  </Link>
                }
              >
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {session.evidence.map((item) => (
                    <span
                      key={item.id}
                      className="rounded-full border border-line bg-surfaceAlt px-2 py-0.5"
                      title={`assessor=${item.assessorType}`}
                    >
                      {TYPE_LABEL[item.evidenceType] ?? item.evidenceType}
                      {item.score === null ? '' : ` · ${item.score}/2`}
                      {` · ${item.assistanceLevel}`}
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-inkMuted">
                  基线评分：{baseline?.score ?? '—'}；即时复测评分：{retest?.score ?? '—'}；
                  复测评估者：{retest ? ASSESSOR_LABEL[retest.assessorType] ?? retest.assessorType : '—'}
                </p>
              </Card>
            );
          })}
        </div>
      )}

      <Card title="全部 AI 关联证据" description="最近 60 条；原始答案保存在会话轮次中，不被 AI 改写。">
        {rows.length === 0 ? (
          <p className="text-xs text-inkMuted">暂无记录。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-inkMuted">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2">时间</th>
                  <th className="py-1.5 pr-2">类型</th>
                  <th className="py-1.5 pr-2">技能</th>
                  <th className="py-1.5 pr-2">评分</th>
                  <th className="py-1.5 pr-2">辅助</th>
                  <th className="py-1.5 pr-2">评估者</th>
                  <th className="py-1.5">会话</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 text-inkMuted">
                      {row.createdAt.toLocaleString('zh-CN')}
                    </td>
                    <td className="py-1.5 pr-2">{TYPE_LABEL[row.evidenceType] ?? row.evidenceType}</td>
                    <td className="py-1.5 pr-2">{row.skill}</td>
                    <td className="py-1.5 pr-2 tabular">{row.score ?? '—'}</td>
                    <td className="py-1.5 pr-2">{LEVEL_LABEL[row.assistanceLevel] ?? row.assistanceLevel}</td>
                    <td className="py-1.5 pr-2">{ASSESSOR_LABEL[row.assessorType] ?? row.assessorType}</td>
                    <td className="py-1.5 truncate">
                      {row.aiSession ? (
                        <Link className="underline" href={`/ai-coach/${row.aiSession.id}`}>
                          {row.aiSession.mode} · {row.aiSession.objective.slice(0, 24)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}