/**
 * `/planner/readiness` 主体：结论卡 + 五维矩阵 + 排除项 + 门禁 + 切换动作。
 *
 * 判定全部来自已落库的 `StageReadinessReview`；页面只做展示与提交动作。
 */

import { Card } from '@/components/ui/Card';
import { diffDays } from '@/lib/date';
import { effectiveReadinessOutcome, type ReadinessSnapshot } from '@/lib/domain/readiness';
import type { ReadinessViewDto } from '@/lib/queries/planner';
import { FiveDimensionMatrix } from './FiveDimensionMatrix';
import { GateChecklistCard } from './GateChecklistCard';
import { NotConsideredPanel } from './NotConsideredPanel';
import { ReadinessConclusion } from './ReadinessConclusion';
import { StageSwitchActions } from './StageSwitchActions';

const SKILL_LABELS: Record<string, string> = {
  LISTENING: '听力',
  READING: '阅读',
  SPEAKING: '口语',
  WRITING: '写作',
};

function formatCoverageRatio(value: number | null): string {
  return value === null ? '未知（未测）' : `${Math.round(value * 100)}%`;
}

function ReadinessSnapshotDetails({
  snapshot,
  reviewRuleVersion,
}: {
  snapshot: ReadinessSnapshot | null;
  reviewRuleVersion: string;
}) {
  if (!snapshot) {
    return (
      <p data-testid="readiness-snapshot-missing" className="text-[11px] text-inkMuted">
        历史评审未记录就绪快照，不回算历史覆盖率。评审记录规则版本：{reviewRuleVersion}。
      </p>
    );
  }

  const invalidSamples = new Map<string, ReadinessSnapshot['invalidSamples'][number]>();
  for (const sample of snapshot.invalidSamples) {
    invalidSamples.set(
      [sample.id, sample.sourceType, sample.skill, sample.subskill ?? '', sample.reason].join('|'),
      sample,
    );
  }
  for (const coverage of Object.values(snapshot.coverageBySkill)) {
    for (const sample of coverage.invalidSamples) {
      invalidSamples.set(
        [sample.id, sample.sourceType, sample.skill, sample.subskill ?? '', sample.reason].join('|'),
        sample,
      );
    }
  }

  return (
    <div data-testid="readiness-snapshot" className="space-y-3 text-[11px]">
      <dl className="grid gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-inkMuted">计算时间（computedAt）</dt>
          <dd className="break-all text-ink">
            <time dateTime={snapshot.computedAt}>{snapshot.computedAt}</time>
          </dd>
        </div>
        <div>
          <dt className="text-inkMuted">数据快照 ID（dataSnapshotId）</dt>
          <dd className="break-all text-ink">{snapshot.dataSnapshotId}</dd>
        </div>
        <div>
          <dt className="text-inkMuted">规则版本</dt>
          <dd className="text-ink">{snapshot.ruleVersion}</dd>
        </div>
        <div>
          <dt className="text-inkMuted">评审记录规则版本</dt>
          <dd className="text-ink">{reviewRuleVersion}</dd>
        </div>
        <div>
          <dt className="text-inkMuted">蓝图版本</dt>
          <dd className="text-ink">
            {snapshot.blueprint.code} · {snapshot.blueprint.version}
          </dd>
        </div>
        <div>
          <dt className="text-inkMuted">阶段 Profile / 蓝图 ID</dt>
          <dd className="break-all text-ink">
            {snapshot.blueprint.stageProfileCode} · {snapshot.blueprint.id}
          </dd>
        </div>
      </dl>

      <div className="space-y-2">
        {Object.values(snapshot.coverageBySkill).map((coverage) => (
          <section
            key={coverage.skill}
            data-testid={`skill-coverage-${coverage.skill}`}
            className="rounded border border-line bg-surfaceAlt/40 px-2.5 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <h3 className="text-xs font-semibold text-ink">
                {SKILL_LABELS[coverage.skill] ?? coverage.skill}（{coverage.skill}）
              </h3>
              <p className="font-medium tabular text-ink">
                {coverage.completed}/{coverage.required} · {formatCoverageRatio(coverage.coverageRatio)}
              </p>
            </div>
            <p className="mt-1 text-inkMuted">
              缺失子维度：
              {coverage.missingSubskills.length > 0 ? coverage.missingSubskills.join('、') : '无'}
            </p>
            <div className="mt-1">
              <p className="font-medium text-ink">必测清单</p>
              {coverage.dimensions.length > 0 ? (
                <ul className="mt-0.5 space-y-1">
                  {coverage.dimensions.map((dimension) => (
                    <li key={`${coverage.skill}:${dimension.subskill}`} className="rounded border border-line/60 bg-white px-2 py-1">
                      <p className="font-medium text-ink">
                        {dimension.completed ? '✓ 已覆盖' : '○ 未覆盖'} · {dimension.subskill}
                        <span className="ml-1 font-normal text-inkMuted">
                          题目 {dimension.itemCodes.length > 0 ? dimension.itemCodes.join('、') : '未记录'}
                        </span>
                      </p>
                      <p className="mt-0.5 break-all text-inkMuted">
                        Evidence IDs：{dimension.evidenceRefs.length > 0 ? dimension.evidenceRefs.join('、') : '无'}
                      </p>
                      <p className="text-inkMuted">
                        来源分类：{dimension.sourceKinds.length > 0 ? dimension.sourceKinds.join('、') : '无'}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-0.5 text-inkMuted">未记录必测清单。</p>
              )}
            </div>
          </section>
        ))}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-ink">无效样本与原因</h3>
        {invalidSamples.size > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {[...invalidSamples.values()].map((sample) => (
              <li
                key={[sample.id, sample.sourceType, sample.skill, sample.subskill ?? '', sample.reason].join('|')}
                className="text-amber-900"
              >
                {sample.id} · {sample.sourceType} · {sample.skill}
                {sample.subskill ? ` / ${sample.subskill}` : ''}：{sample.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-inkMuted">没有记录无效样本。</p>
        )}
      </div>
    </div>
  );
}

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

      {review && (
        <Card
          title="就绪快照与技能覆盖"
          description="回放评审落库时的必测清单、证据来源与无效样本；历史快照缺失时不回算"
        >
          <ReadinessSnapshotDetails snapshot={review.snapshot} reviewRuleVersion={review.ruleVersion} />
        </Card>
      )}

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