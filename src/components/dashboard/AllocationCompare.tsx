/**
 * Dashboard ⑤b 四技能配比：实际 vs 建议（v2.0 新增）。
 *
 * 与 ⑤ 四项投入的区别：
 *   ⑤ 展示「绝对时长 + 四技能分母内的占比」；
 *   ⑤b 展示「实际配比 vs 阶段建议配比」的**偏离**，直接回答「我偏科了吗」。
 *
 * 分母严格只含四项技能专项训练时间 —— 词汇/语法/复盘/泛练一律不进分母
 * （SOP v2 §2 原文）。本条由 `skillShare()` 保证，组件自身不做任何除法。
 */

import { ALLOCATION_SKILLS, PRIMARY_SKILL_LABEL_ZH, STAGE_PROFILE_LABEL_ZH } from '@/lib/constants';
import { allocationDeviation, skillShare, type PrimarySkillMinutes } from '@/lib/domain/allocation';
import { formatDurationZh, formatPercent } from '@/lib/format';
import type { AllocationSkill, SkillAllocation, StageProfileCode } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export interface AllocationCompareProps {
  minutes: PrimarySkillMinutes;
  target: SkillAllocation;
  profileCode: StageProfileCode | null;
}

/** 偏离度 → 一句话判读（正 = 超配，负 = 欠配）。 */
function deviationText(value: number): { text: string; tone: 'over' | 'under' | 'ok' } {
  if (value >= 5) return { text: `超 ${value.toFixed(0)}pt`, tone: 'over' };
  if (value <= -5) return { text: `欠 ${Math.abs(value).toFixed(0)}pt`, tone: 'under' };
  return { text: '接近', tone: 'ok' };
}

export function AllocationCompare({ minutes, target, profileCode }: AllocationCompareProps) {
  const share = skillShare(minutes);
  const deviation = allocationDeviation(minutes, target);

  const hasData = share.denominator > 0;

  return (
    <Card
      title="四技能配比：实际 vs 建议"
      description={
        profileCode
          ? `建议配比来自当前阶段「${STAGE_PROFILE_LABEL_ZH[profileCode]}」。分母只含四项专项训练时间，词汇语法复盘不进分母。`
          : '分母只含四项专项训练时间，词汇语法复盘不进分母。'
      }
    >
      {!hasData ? (
        <p className="text-[11px] text-inkMuted">
          本周还没有四项技能专项训练的时长记录，因此占比显示为「—」而不是 0%
          （「没有数据」与「各占 0%」是两件事）。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {ALLOCATION_SKILLS.map((skill: AllocationSkill) => {
            const actual = share.share[skill];
            const targetShare = target[skill] / 100;
            const dev = deviation ? deviation[skill] : null;
            const judge = dev === null ? null : deviationText(dev);

            return (
              <li key={skill} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="w-20 shrink-0 text-inkMuted">{PRIMARY_SKILL_LABEL_ZH[skill]}</span>
                  <span className="tabular text-ink">
                    {actual === null ? '—' : formatPercent(actual)}
                  </span>
                  <span className="tabular w-14 shrink-0 text-right text-inkMuted">
                    / 建议 {formatPercent(targetShare)}
                  </span>
                  <span
                    className={[
                      'tabular w-16 shrink-0 text-right',
                      judge?.tone === 'over'
                        ? 'text-amber-600'
                        : judge?.tone === 'under'
                          ? 'text-rose-600'
                          : 'text-inkMuted',
                    ].join(' ')}
                  >
                    {judge?.text ?? '—'}
                  </span>
                </div>
                {/* 双条对比：上条实际，下条建议（同比例尺） */}
                <div className="mt-0.5 space-y-0.5">
                  <span className="block h-1.5 overflow-hidden rounded bg-line" aria-hidden="true">
                    <span
                      className="block h-full rounded bg-brand"
                      style={{ width: `${Math.min(100, Math.round((actual ?? 0) * 100))}%` }}
                    />
                  </span>
                  <span className="block h-1 rounded bg-line" aria-hidden="true">
                    <span
                      className="block h-full rounded bg-slate-400"
                      style={{ width: `${Math.min(100, Math.round(targetShare * 100))}%` }}
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-inkMuted">
        四技能分母 {formatDurationZh(share.denominator)}
        · 支持性时间 {formatDurationZh(share.foundationMinutes)} 单列（不进分母）
        {deviation === null && hasData ? '' : ''}
      </p>
      <p className="mt-1 text-[11px] text-inkMuted">
        偏离 ±5 个百分点以内视为「接近」。配比调整建议需连续两周偏离才提出，单周波动不改计划。
      </p>
    </Card>
  );
}
