'use client';

/**
 * 雅思工作区主体（v2.0 P4）。
 *
 * 核心口径：IELTS gate **只看 IeltsAssessment**（正式/模考成绩），
 * 不读 CEFR 评估、不读媒介学习 —— 成绩独立性由结构保证。
 * 趋势图：总分（实线）+ 四单项（虚线），正式/模考分开展示。
 */

import { useRouter } from 'next/navigation';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { IELTS_TEST_TYPE_LABEL_ZH } from '@/lib/constants';
import type { TrackGateResult } from '@/lib/domain/tracks';
import { Card } from '@/components/ui/Card';
import { ChartFrame } from '@/components/charts/ChartFrame';
import { EmptyState } from '@/components/ui/EmptyState';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';
import { IeltsAssessmentForm } from './IeltsAssessmentForm';

export interface IeltsRecordDto {
  id: string;
  testDate: string;
  testType: 'OFFICIAL' | 'MOCK' | 'PRACTICE';
  overallBand: number;
  listeningBand: number | null;
  readingBand: number | null;
  writingBand: number | null;
  speakingBand: number | null;
  source: string | null;
  notes: string | null;
}

export interface IeltsOverviewDto {
  target: {
    overall: number;
    listening: number | null;
    reading: number | null;
    writing: number | null;
    speaking: number | null;
  };
  records: IeltsRecordDto[];
  gate: TrackGateResult;
  milestones: {
    id: string;
    title: string;
    description: string | null;
    target: string | null;
    status: 'PENDING' | 'ACHIEVED' | 'FAILED';
    completedAt: string | null;
  }[];
  validRecordCount: number;
  minRecords: number;
  maxRecords: number;
}

const BAND_LINES: { key: 'listening' | 'reading' | 'writing' | 'speaking'; label: string; color: string }[] = [
  { key: 'listening', label: '听力', color: '#3b82f6' },
  { key: 'reading', label: '阅读', color: '#10b981' },
  { key: 'writing', label: '写作', color: '#f59e0b' },
  { key: 'speaking', label: '口语', color: '#ef4444' },
];

/** 最新一条有效成绩（OFFICIAL/MOCK，按日期最新）。 */
function latestValid(records: IeltsRecordDto[]): IeltsRecordDto | null {
  const valid = records.filter((r) => r.testType === 'OFFICIAL' || r.testType === 'MOCK');
  if (valid.length === 0) return null;
  return valid[valid.length - 1];
}

export function IeltsPageBody({ overview }: { overview: IeltsOverviewDto }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();

  const latest = latestValid(overview.records);
  const target = overview.target;

  const chartData = overview.records.map((r) => ({
    label: `${r.testDate.slice(5)}${r.testType === 'OFFICIAL' ? '·正式' : r.testType === 'MOCK' ? '·模考' : '·单项'}`,
    overall: r.overallBand,
    listening: r.listeningBand ?? null,
    reading: r.readingBand ?? null,
    writing: r.writingBand ?? null,
    speaking: r.speakingBand ?? null,
  }));

  const gapRows: { label: string; latest: number | null; target: number | null }[] = [
    { label: '总分', latest: latest?.overallBand ?? null, target: target.overall },
    { label: '听力', latest: latest?.listeningBand ?? null, target: target.listening },
    { label: '阅读', latest: latest?.readingBand ?? null, target: target.reading },
    { label: '写作', latest: latest?.writingBand ?? null, target: target.writing },
    { label: '口语', latest: latest?.speakingBand ?? null, target: target.speaking },
  ];

  const byType: Record<IeltsRecordDto['testType'], IeltsRecordDto[]> = {
    OFFICIAL: [],
    MOCK: [],
    PRACTICE: [],
  };
  for (const r of overview.records) byType[r.testType].push(r);
  // 最新在前
  for (const key of Object.keys(byType) as IeltsRecordDto['testType'][]) byType[key].reverse();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">雅思工作区</h1>
          <p className="text-xs text-inkMuted">
            目标总分 {target.overall}
            {target.listening !== null && ` · 听力 ≥${target.listening}`}
            {target.reading !== null && ` · 阅读 ≥${target.reading}`}
            {target.writing !== null && ` · 写作 ≥${target.writing}`}
            {target.speaking !== null && ` · 口语 ≥${target.speaking}`}
          </p>
        </div>
      </div>

      {/* 独立 gate */}
      <Card
        title="雅思验收（独立 gate）"
        description={overview.gate.basis}
        actions={
          overview.gate.suggested ? (
            <TagBadge tone="info">建议达标</TagBadge>
          ) : (
            <span className="text-[11px] text-inkMuted">未达标</span>
          )
        }
      >
        {/* 目标差距：最新有效成绩 vs 目标 */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {gapRows.map((row) => {
            const met =
              row.latest !== null &&
              row.target !== null &&
              row.latest >= row.target;
            const na = row.target === null;
            return (
              <div
                key={row.label}
                className="rounded border border-line bg-surfaceAlt px-2.5 py-2 text-center"
              >
                <div className="text-[11px] text-inkMuted">{row.label}</div>
                <div className="mt-0.5 text-lg font-semibold text-ink">
                  {row.latest === null ? '—' : row.latest}
                </div>
                <div className="text-[10px] text-inkMuted">
                  {na ? '未设目标' : met ? '已达标' : '未达标'}
                  {na ? '' : ` / 目标 ${row.target}`}
                </div>
              </div>
            );
          })}
        </div>

        {overview.gate.gaps.length === 0 ? (
          <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            已满足：最近 {overview.validRecordCount} 次有效成绩稳定达目标。
            独立验收结论，是否升级仍需你确认。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {overview.gate.gaps.map((gap) => (
              <li
                key={gap.code}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
              >
                <span className="font-medium text-amber-900">{gap.label}</span>
                <span className="text-amber-800">
                  当前 {gap.current} · 目标 {gap.target}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-inkMuted">
          有效成绩 {overview.validRecordCount} 条（需 ≥{overview.minRecords} 条，取最近 {overview.maxRecords} 次）· 只读 IeltsAssessment，与 CEFR / 媒介互不换算
        </p>
      </Card>

      <IeltsAssessmentForm onToast={show} onSaved={() => router.refresh()} />

      {overview.records.length === 0 ? (
        <EmptyState
          icon="flag"
          title="还没有雅思成绩"
          description="IELTS gate 需要至少 2 次有效模考/正式成绩，且每次总分与单项都稳定达标。单项练习（PRACTICE）不计入判定。"
          primary={{ label: '录入第一条成绩', href: '/ielts' }}
        />
      ) : (
        <>
          <Card
            title="成绩趋势"
            description="总分实线 + 四单项虚线；横轴标注正式/模考/单项。空缺单项不连线（不补 0）。"
          >
            <ChartFrame height={240} ariaLabel="雅思成绩趋势">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 10, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                    interval="preserveStartEnd"
                    minTickGap={12}
                  />
                  <YAxis
                    domain={[0, 9]}
                    ticks={[0, 3, 4, 5, 6, 7, 8, 9]}
                    tick={{ fontSize: 10, fill: 'var(--color-ink-muted)' }}
                  />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: 'var(--color-line)' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="overall"
                    name="总分"
                    stroke="var(--color-brand)"
                    strokeWidth={2.5}
                    dot={{ r: 2.5 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  {BAND_LINES.map((line) => (
                    <Line
                      key={line.key}
                      type="monotone"
                      dataKey={line.key}
                      name={line.label}
                      stroke={line.color}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={{ r: 1.5 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          </Card>

          <Card
            title="成绩历史（正式 vs 模考分区）"
            description={`共 ${overview.records.length} 条 · 按类型分区，最新在前`}
          >
            {(['OFFICIAL', 'MOCK', 'PRACTICE'] as const).map((type) => {
              const rows = byType[type];
              if (rows.length === 0) return null;
              return (
                <div key={type} className="mb-3 last:mb-0">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-ink">
                      {IELTS_TEST_TYPE_LABEL_ZH[type]}
                    </span>
                    <span className="text-[11px] text-inkMuted">{rows.length} 条</span>
                  </div>
                  <ul className="divide-y divide-line rounded border border-line">
                    {rows.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]">
                        <span className="flex items-center gap-1.5">
                          <span className="tabular text-inkMuted">{r.testDate}</span>
                          <span className="rounded bg-brand px-1.5 py-0.5 font-semibold text-white">
                            总分 {r.overallBand}
                          </span>
                          {r.source && <span className="text-inkMuted">{r.source}</span>}
                        </span>
                        <span className="tabular text-inkMuted">
                          L {r.listeningBand ?? '—'} · R {r.readingBand ?? '—'} · W{' '}
                          {r.writingBand ?? '—'} · S {r.speakingBand ?? '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </Card>
        </>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
