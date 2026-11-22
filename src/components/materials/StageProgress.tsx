'use client';

/**
 * 阶段进度条。
 *
 * 百分比不是「阶段数 / 5」，而是按 `MATERIAL_STAGE_WEIGHTS` 加权 ——
 * 解析一个 200 页 PDF 时，用户看到的进度应主要反映 extracting 的耗时，
 * 而不是「两个阶段打勾就 40%」。
 */

import {
  MATERIAL_JOB_STAGES,
  MATERIAL_JOB_STAGE_LABELS_ZH,
  MATERIAL_STAGE_WEIGHTS,
  type MaterialJobStage,
} from '@/lib/constants';
import type { ProcessingStageDto } from '@/lib/queries/materials';
import { Icon } from '@/components/ui/Icon';

const STATUS_TEXT: Record<ProcessingStageDto['status'], string> = {
  done: '完成',
  active: '进行中',
  pending: '等待',
  failed: '失败',
};

function percentOf(stages: ProcessingStageDto[], current: MaterialJobStage | null): number {
  const total = MATERIAL_JOB_STAGES.reduce((sum, stage) => sum + MATERIAL_STAGE_WEIGHTS[stage], 0);
  let earned = 0;
  for (const stage of stages) {
    const weight = MATERIAL_STAGE_WEIGHTS[stage.stage] ?? 0;
    if (stage.status === 'done') earned += weight;
    else if (stage.status === 'active') earned += weight * 0.5;
  }
  // 没有可判定阶段时按当前阶段兜底，避免进度条永远停在 0
  if (earned === 0 && current) earned = (MATERIAL_STAGE_WEIGHTS[current] ?? 0) * 0.1;
  return Math.min(99, Math.round((earned / total) * 100));
}

export function StageProgress({
  stages,
  current,
}: {
  stages: ProcessingStageDto[];
  current: MaterialJobStage | null;
}) {
  const percent = percentOf(stages, current);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink">
          {current ? MATERIAL_JOB_STAGE_LABELS_ZH[current] : '已结束'}
        </span>
        <span className="text-[11px] text-inkMuted">总进度约 {percent}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="材料处理总进度"
        className="h-1.5 w-full overflow-hidden rounded-full bg-surfaceAlt"
      >
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
      </div>

      <ol className="space-y-1">
        {stages.map((stage) => (
          <li key={stage.stage} className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden="true"
              className={[
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                stage.status === 'done'
                  ? 'border-egGreen/40 bg-egGreen/10 text-egGreen'
                  : stage.status === 'active'
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : stage.status === 'failed'
                      ? 'border-egRed/40 bg-egRed/10 text-egRed'
                      : 'border-line bg-surfaceAlt text-inkMuted',
              ].join(' ')}
            >
              {stage.status === 'done' ? (
                <Icon name="check" size={10} />
              ) : stage.status === 'failed' ? (
                <Icon name="alert" size={10} />
              ) : (
                <Icon name={stage.status === 'active' ? 'clock' : 'circle'} size={10} />
              )}
            </span>
            <span className={stage.status === 'pending' ? 'text-inkMuted' : 'text-ink'}>{stage.label}</span>
            <span className="text-inkMuted">· {STATUS_TEXT[stage.status]}</span>
            {stage.ms !== null && (
              <span className="text-inkMuted">
                · {(stage.ms / 1000).toFixed(stage.ms >= 10_000 ? 0 : 1)}s
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
