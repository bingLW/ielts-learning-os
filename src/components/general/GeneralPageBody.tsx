'use client';

/**
 * 通用英语工作区主体（v2.0 P4）。
 *
 * 三个 Tab（URL `?tab=`，服务端分派）：
 *   - `assessment`（默认）：独立 gate + 录入表单 + CEFR 历史；
 *   - `allocation`：四技能配比 vs 建议；
 *   - `milestones`：阶段里程碑。
 *
 * 核心口径：General English gate **只看 SkillAssessment**，学习时长绝不参与判定。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ALLOCATION_SKILLS,
  ASSESSMENT_TYPE_LABEL_ZH,
  MILESTONE_STATUS_LABEL_ZH,
  PRIMARY_SKILL_LABEL_ZH,
} from '@/lib/constants';
import type { AllocationSkill, CefrLevel } from '@/lib/types';
import type { TrackGateResult } from '@/lib/domain/tracks';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TagBadge } from '@/components/ui/StatusBadge';
import { Toast, useToastState } from '@/components/ui/Toast';
import { AllocationCompare } from '@/components/dashboard/AllocationCompare';
import { SkillAssessmentForm } from './SkillAssessmentForm';

export type GeneralTabKey = 'assessment' | 'allocation' | 'milestones';

export interface GeneralOverviewDto {
  cefrTarget: CefrLevel;
  assessments: {
    id: string;
    skill: AllocationSkill;
    cefrLevel: CefrLevel;
    assessmentType: string;
    score: string | null;
    assessDate: string;
    assessor: string;
    confidence: number;
    note: string | null;
  }[];
  gate: TrackGateResult;
  milestones: {
    id: string;
    milestoneCode: string;
    title: string;
    description: string | null;
    target: string | null;
    status: 'PENDING' | 'ACHIEVED' | 'FAILED';
    completedAt: string | null;
  }[];
  allocation: {
    minutes: { LISTENING: number; READING: number; SPEAKING: number; WRITING: number; FOUNDATION: number };
    target: { LISTENING: number; READING: number; SPEAKING: number; WRITING: number } | null;
    profileCode: string | null;
  };
}

const TABS: { key: GeneralTabKey; labelZh: string }[] = [
  { key: 'assessment', labelZh: 'CEFR 评估' },
  { key: 'allocation', labelZh: '四技能配比' },
  { key: 'milestones', labelZh: '里程碑' },
];

export function GeneralPageBody({
  overview,
  activeTab,
}: {
  overview: GeneralOverviewDto;
  activeTab: GeneralTabKey;
}) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();

  // 四项技能最新评估（短板即当前水平）
  const latestBySkill = new Map<AllocationSkill, CefrLevel>();
  for (const a of overview.assessments) latestBySkill.set(a.skill, a.cefrLevel);

  const assessedCount = ALLOCATION_SKILLS.filter((s) => latestBySkill.has(s)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">通用英语</h1>
          <p className="text-xs text-inkMuted">
            目标 CEFR {overview.cefrTarget} · 四项技能独立评估，缺证据不判级 · 学习时长不参与判定
          </p>
        </div>
      </div>

      <nav aria-label="通用英语工作区" className="flex flex-wrap gap-1.5">
        {TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <Link
              key={tab.key}
              href={tab.key === 'assessment' ? '/general' : `/general?tab=${tab.key}`}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'rounded border px-2.5 py-1 text-[11px] transition-colors',
                isActive
                  ? 'border-brand bg-brand font-medium text-white'
                  : 'border-line bg-white text-ink hover:bg-surfaceAlt',
              ].join(' ')}
            >
              {tab.labelZh}
            </Link>
          );
        })}
      </nav>

      {activeTab === 'allocation' && (
        <AllocationCompare
          minutes={overview.allocation.minutes}
          target={overview.allocation.target ?? { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 }}
          profileCode={(overview.allocation.profileCode as never) ?? null}
        />
      )}

      {activeTab === 'assessment' && (
        <>
          <Card
            title="通用英语验收（独立 gate）"
            description={overview.gate.basis}
            actions={
              overview.gate.suggested ? (
                <TagBadge tone="info">建议达标</TagBadge>
              ) : (
                <span className="text-[11px] text-inkMuted">未达标</span>
              )
            }
          >
            {/* 四技能当前等级概览 */}
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ALLOCATION_SKILLS.map((skill) => {
                const level = latestBySkill.get(skill);
                return (
                  <div
                    key={skill}
                    className="rounded border border-line bg-surfaceAlt px-2.5 py-2 text-center"
                  >
                    <div className="text-[11px] text-inkMuted">{PRIMARY_SKILL_LABEL_ZH[skill]}</div>
                    <div className="mt-0.5 text-lg font-semibold text-ink">
                      {level ?? '—'}
                    </div>
                    <div className="text-[10px] text-inkMuted">
                      {level ? '最近评估' : '无评估证据'}
                    </div>
                  </div>
                );
              })}
            </div>

            {overview.gate.gaps.length === 0 ? (
              <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                已满足：四项技能均有评估证据且最近等级均达 {overview.cefrTarget}。
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
              已评估 {assessedCount}/4 项技能 · 证据来自 SkillAssessment，与 IELTS 成绩、媒介学习互不换算
            </p>
          </Card>

          <SkillAssessmentForm
            onToast={show}
            onSaved={() => router.refresh()}
          />

          {overview.assessments.length === 0 ? (
            <EmptyState
              icon="flag"
              title="还没有能力评估"
              description="通用英语 gate 需要四项技能（听/读/说/写）各有评估证据。只记录学习时长、不做评估，不会判级。"
              primary={{ label: '录入第一条评估', href: '/general?tab=assessment' }}
            />
          ) : (
            <Card
              title="CEFR 评估历史"
              description={`共 ${overview.assessments.length} 条 · 按技能分组，最新在上`}
            >
              <ul className="divide-y divide-line">
                {ALLOCATION_SKILLS.map((skill) => {
                  const rows = overview.assessments
                    .filter((a) => a.skill === skill)
                    .slice()
                    .reverse(); // 最新在前
                  if (rows.length === 0) return null;
                  return (
                    <li key={skill} className="py-2.5 first:pt-0 last:pb-0">
                      <div className="text-[12px] font-medium text-ink">
                        {PRIMARY_SKILL_LABEL_ZH[skill]}
                        <span className="ml-1.5 text-[11px] font-normal text-inkMuted">
                          {rows.length} 条
                        </span>
                      </div>
                      <ul className="mt-1 space-y-1">
                        {rows.map((row) => (
                          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <span className="flex items-center gap-1.5">
                              <span className="tabular rounded bg-surfaceAlt px-1.5 py-0.5 font-medium text-ink">
                                {row.cefrLevel}
                              </span>
                              <span className="tabular text-inkMuted">{row.assessDate}</span>
                              <span className="text-inkMuted">
                                {ASSESSMENT_TYPE_LABEL_ZH[row.assessmentType as never] ?? row.assessmentType}
                              </span>
                              {row.score && <span className="text-inkMuted">· {row.score}</span>}
                            </span>
                            <span className="text-inkMuted">置信 {row.confidence}/5</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}

      {activeTab === 'milestones' && (
        <Card
          title="阶段里程碑"
          description="里程碑是目标分解的检查点；gate 达标 + 里程碑达成，才构成升级的完整证据链。"
        >
          {overview.milestones.length === 0 ? (
            <p className="text-[11px] text-inkMuted">尚未配置里程碑。</p>
          ) : (
            <ul className="divide-y divide-line">
              {overview.milestones.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-ink">{m.title}</div>
                    {m.description && <div className="text-[11px] text-inkMuted">{m.description}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {m.target && <span className="text-[11px] text-inkMuted">目标 {m.target}</span>}
                    <TagBadge tone={m.status === 'ACHIEVED' ? 'info' : 'neutral'}>
                      {MILESTONE_STATUS_LABEL_ZH[m.status]}
                    </TagBadge>
                    {m.completedAt && (
                      <span className="tabular text-[11px] text-inkMuted">{m.completedAt}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
