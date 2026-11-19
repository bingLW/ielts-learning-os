'use client';

/**
 * 媒介学习工作区主体。
 *
 * 顶部：独立 gate 判定卡（只读媒介证据，不换算 CEFR/IELTS）+ 统计磁贴；
 * 中间：新建记录表单（可收起）；
 * 底部：历史记录列表（主题/理解度/翻译依赖/产出/净分钟）。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createMediatedEvidenceAction } from '@/lib/actions/mediated';
import { PRIMARY_SKILL_LABEL_ZH, SOURCE_TYPE_LABEL_ZH } from '@/lib/constants';
import { formatDurationZh } from '@/lib/format';
import type { MediatedSessionDto } from '@/lib/types';
import type { TrackGateResult } from '@/lib/domain/tracks';
import { Button, buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';
import { MediatedForm } from './MediatedForm';

export interface MediatedPageBodyProps {
  sessions: MediatedSessionDto[];
  overview: {
    totalSessions: number;
    totalMinutes: number;
    totalOutputs: number;
    skillCoverage: Partial<Record<string, number>>;
    gate: TrackGateResult;
    intensity: string;
    summaryAdequateCount: number;
  };
  defaultSubject: string;
  showForm: boolean;
}

function understandingTone(value: string): 'mastery' | 'warn' | 'neutral' {
  if (value === 'FULL') return 'mastery';
  if (value === 'LOW') return 'warn';
  return 'neutral';
}

export function MediatedPageBody({
  sessions,
  overview,
  defaultSubject,
  showForm,
}: MediatedPageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [evidenceTarget, setEvidenceTarget] = useState<MediatedSessionDto | null>(null);
  const [pending, startTransition] = useTransition();

  function confirmEvidence() {
    const target = evidenceTarget;
    if (!target) return;
    startTransition(async () => {
      const result = await createMediatedEvidenceAction({ mediatedId: target.id });
      setEvidenceTarget(null);
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('已生成证据，可在证据中心查看');
      router.refresh();
    });
  }

  const gate = overview.gate;
  const skillsUsed = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].filter(
    (s) => (overview.skillCoverage[s] ?? 0) > 0,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">英语媒介学习</h1>
          <p className="text-xs text-inkMuted">
            用英语学知识（默认 {defaultSubject}）· 独立统计与验收，不与 CEFR / IELTS 换算
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {showForm ? (
            <Link href="/mediated" className={buttonClass('secondary', 'sm')}>
              收起表单
            </Link>
          ) : (
            <Link href="/mediated?new=1" className={buttonClass('primary', 'sm')}>
              <Icon name="plus" size={13} />
              新建记录
            </Link>
          )}
        </div>
      </div>

      {showForm && (
        <MediatedForm
          defaultSubject={defaultSubject}
          onToast={show}
          onSaved={() => router.push('/mediated')}
        />
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile
          label="记录次数"
          value={overview.totalSessions}
          unit="次"
          tone="neutral"
          scopeNote="EnglishMediatedSession 条数"
        />
        <StatTile
          label="媒介净时长"
          value={overview.totalMinutes}
          unit="分"
          tone="actual"
          scopeNote="时长只计一次，来自 StudySession"
        />
        <StatTile
          label="英文产出"
          value={overview.totalOutputs}
          unit="条"
          tone="output"
          scopeNote="笔记/摘要/问题任一非空"
        />
        <StatTile
          label="技能覆盖"
          value={skillsUsed.length}
          unit="/4"
          tone="mastery"
          scopeNote="已用 L/R/S/W 技能数"
        />
      </div>

      <Card
        title="媒介学习验收（独立 gate）"
        description={gate.basis}
        actions={
          gate.suggested ? (
            <TagBadge>建议达标</TagBadge>
          ) : (
            <span className="text-[11px] text-inkMuted">未达标</span>
          )
        }
      >
        {gate.gaps.length === 0 ? (
          <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            已满足：有效记录次数达标、四技能均有覆盖、理解度与翻译独立度均达阈值。
            此项独立验收，是否升级仍需你确认。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {gate.gaps.map((gap) => (
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
      </Card>

      {sessions.length === 0 ? (
        <EmptyState
          icon="bookOpen"
          title="还没有媒介学习记录"
          description="媒介学习是三条轨道之一：用英语去学其他知识（如法语），而不是把英语本身当学习对象。它锻炼的是「跨技能应用」。"
          primary={{ label: '新建第一条记录', href: '/mediated?new=1' }}
          secondary={{ label: '回 Dashboard', href: '/' }}
        />
      ) : (
        <Card
          title="历史记录"
          description={`共 ${sessions.length} 条 · 按日期倒序 · 摘要达标（≥40 字）${overview.summaryAdequateCount} 条`}
        >
          <ul className="divide-y divide-line">
            {sessions.map((session) => (
              <li key={session.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="tabular text-[11px] text-inkMuted">{session.sessionDate}</span>
                      <span className="text-[12px] font-medium text-ink">{session.topic}</span>
                      <span className="rounded bg-surfaceAlt px-1 py-0.5 text-[10px] text-inkMuted">
                        {session.subject}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-inkMuted">
                      {PRIMARY_SKILL_LABEL_ZH[session.primarySkill]} ·{' '}
                      {SOURCE_TYPE_LABEL_ZH[session.sourceType] ?? session.sourceType}
                      {session.sourceTitle ? ` · ${session.sourceTitle}` : ''}
                    </div>
                    {session.summaryEn && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-ink">{session.summaryEn}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatTile
                      label="净时长"
                      value={formatDurationZh(session.actualNetMinutes)}
                      tone={understandingTone(session.understanding)}
                    />
                    <span className="text-[10px] text-inkMuted">
                      产出 {session.outputCount} 条
                    </span>
                    {session.evidenceId ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                        已生成证据
                      </span>
                    ) : session.outputCount > 0 ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending}
                        onClick={() => setEvidenceTarget(session)}
                      >
                        生成证据
                      </Button>
                    ) : (
                      <span className="text-[10px] text-inkMuted">无英文产出，不能生成证据</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={evidenceTarget !== null}
        title="由这条媒介学习记录生成证据？"
        danger={false}
        confirmLabel="生成证据"
        busy={pending}
        description={
          evidenceTarget
            ? `「${evidenceTarget.topic}」将生成一条 APPLIED_TASK 证据：仅计入 ${PRIMARY_SKILL_LABEL_ZH[evidenceTarget.primarySkill]} 一项技能；级别按摘要长度判定，辅助级别按翻译依赖判定。每条记录只能生成一次，生成后可在证据中心归档。`
            : undefined
        }
        onConfirm={confirmEvidence}
        onCancel={() => setEvidenceTarget(null)}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
