/**
 * `/exercises/[setId]` 作答页。
 *
 * 硬规则：题目来自 `getExerciseSet(setId, { revealAnswers: false })`，
 * `correctKey` / `explanation` **在服务端就被抹成 null** —— 页面 source 里看不到答案，
 * 浏览器网络面板里也看不到。这不是"渲染时隐藏"，而是"根本不发出去"。
 *
 * 哪些题能作答由 `domain/materialExerciseGate` 判定（`approved` / `draft` /
 * `needs_review` 可练，`rejected` / `retired` 与未知状态一律不给入口）。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExercisePlayer } from '@/components/materials/ExercisePlayer';
import { isLowRiskPracticeAllowed } from '@/lib/domain/materialExerciseGate';
import { getExerciseSet } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ setId: string }>;
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors';

export default async function ExerciseSetPage({ params }: PageProps) {
  const { setId } = await params;

  const detail = await getExerciseSet(setId, { revealAnswers: false });
  if (!detail) notFound();

  const practicable = detail.exercises.filter(
    (exercise) => exercise.retiredAt === null && isLowRiskPracticeAllowed(exercise.reviewStatus),
  );

  const { set, materialStatus, attempts } = detail;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-ink">{set.title}</h1>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            {set.materialTitle} · {set.targetSkillLabel} · 约 {set.estimatedMinutes} 分钟 · 共{' '}
            {set.counts.total} 道题
            {set.difficultyLevel ? ` · AI 难度估计 ${set.difficultyLevel}` : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            已通过 {set.counts.approved} 道 · 待处理{' '}
            {set.counts.draft + set.counts.needsReview} 道 · 已作答 {attempts.length} 次
            {set.hasApprovedOnly ? ' · 全部题已审核通过' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/materials/${set.materialId}/exercises`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            题目审核
          </Link>
          <Link
            href={`/materials/${set.materialId}/read`}
            className={`${LINK_CLASS} border-line bg-surface text-ink hover:bg-surfaceAlt`}
          >
            读原文
          </Link>
        </div>
      </div>

      {materialStatus === 'generating' || materialStatus === 'analyzing' ? (
        <p className="rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-inkMuted">
          材料还在处理中，题目可能会继续增加。可以先做已生成的题，稍后刷新即可。
        </p>
      ) : null}

      {practicable.length < detail.exercises.length && (
        <p className="rounded-md border border-line bg-surfaceAlt p-2 text-[11px] leading-relaxed text-inkMuted">
          有 {detail.exercises.length - practicable.length} 道题当前不可作答（已拒绝或已退役），
          它们不会出现在这一轮练习里。
        </p>
      )}

      <ExercisePlayer
        setId={set.id}
        materialId={set.materialId}
        exercises={practicable}
      />
    </div>
  );
}
