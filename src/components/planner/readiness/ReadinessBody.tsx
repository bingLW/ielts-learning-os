/**
 * `/planner/readiness` 主体：结论卡 + 五维矩阵 + 排除项 + 门禁 + 切换动作。
 *
 * 判定全部来自已落库的 `StageReadinessReview`；页面只做展示与提交动作。
 */

import { Card } from '@/components/ui/Card';
import { diffDays } from '@/lib/date';
import { effectiveReadinessOutcome } from '@/lib/domain/readiness';
import type { ReadinessViewDto } from '@/lib/queries/planner';
import { FiveDimensionMatrix } from './FiveDimensionMatrix';
import { GateChecklistCard } from './GateChecklistCard';
import { NotConsideredPanel } from './NotConsideredPanel';
import { ReadinessConclusion } from './ReadinessConclusion';
import { StageSwitchActions } from './StageSwitchActions';

export function ReadinessBody({
  view,
  asOfDate,
  stages,
}: {
  view: ReadinessViewDto;
  asOfDate: string;
  stages: { code: string; label: string }[];
}) {
  const review = view.latestReview;
  const dimensions = review?.criteria ?? [];
  const outcome = effectiveReadinessOutcome(review?.outcome ?? null, dimensions);
  const stageAgeDays = view.stage?.startDate ? diffDays(view.stage.startDate, asOfDate) : null;
  const earlyStage = stageAgeDays !== null && stageAgeDays < 7;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">阶段就绪评审</h1>
          <p className="text-xs text-inkMuted">
            {view.stage ? `${view.stage.nameZh}（${view.stage.code}）` : '没有进行中的阶段'} · 基准日{' '}
            {asOfDate} · 证据 {view.evidenceCount} 条
            {review ? ` · 最近评审 ${review.createdAt.slice(0, 10)}` : ''}
          </p>
        </div>
      </header>

      {earlyStage && (
        <div
          data-testid="early-stage-notice"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <p className="font-medium">阶段早期，readiness 判定无意义</p>
          <p className="mt-0.5">
            本阶段开始仅 {stageAgeDays} 天（&lt; 7 天）：先积累证据。下面只显示已收集的证据计数与历史评审，
            不建议据此切换阶段。
          </p>
        </div>
      )}

      <ReadinessConclusion
        outcome={review?.outcome ?? null}
        dimensions={dimensions}
        userConfirmed={review?.userConfirmed ?? false}
        confirmedBy={review?.confirmedBy ?? null}
        confirmedAt={review?.confirmedAt ?? null}
      />

      <Card title="五维证据矩阵" description="每一维给 PASS / FAIL / 数据不足；依据全部来自证据记录">
        <FiveDimensionMatrix dimensions={dimensions} />
        {review && review.unmet.length > 0 && (
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5">
            <p className="text-[11px] font-medium text-amber-900">未满足项</p>
            <ul className="mt-0.5 space-y-0.5">
              {review.unmet.map((item) => (
                <li key={item} className="text-[11px] text-amber-900">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="不参与判定的指标（反例）" description="它们现在可能很好看，但不会让结论变 Ready">
        <NotConsideredPanel rows={view.notConsidered} />
      </Card>

      <Card title="验收门禁（H1–H5）" description="与五维 readiness 并列展示；H4 仅作参考">
        <GateChecklistCard gate={view.gate} />
      </Card>

      {view.stage && (
        <Card title="切换动作" description="系统只建议；确认切换会写 append-only 的阶段切换日志">
          <StageSwitchActions
            stageId={view.stage.id}
            asOfDate={asOfDate}
            currentStageCode={view.stage.code}
            outcome={outcome}
            reviewId={review?.id ?? null}
            stages={stages}
          />
        </Card>
      )}
    </div>
  );
}