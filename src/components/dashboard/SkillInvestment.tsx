/**
 * Dashboard ⑤ 四项投入：听/读/说/写实际净分钟。
 *
 * v2.0 口径修正（缺陷 D20）：
 *   v1.5 用「8 桶之和」当分母，导致词汇/语法/泛练把四技能占比压低，
 *   与 SOP v2 §2「词汇、语法、发音讲解、复盘和工具学习不进入该比例的分母」直接冲突。
 *   现在占比一律走 `skillShare()`：**分母只含 L+R+S+W**，
 *   支持性时间（泛练 + 语言知识 + 复盘）单独列出，只做绝对时长展示。
 *
 * 媒介学习桶理论上恒为 0：媒介学习时长落库时已按该次 `primarySkill`
 * 计入四技能之一，绝不再单独加一遍（否则就是双计）。若非 0，说明有脏数据，页面会提示。
 */

import { SKILL_BUCKET_LABEL_ZH, SKILL_BUCKET_ORDER } from '@/lib/constants';
import { skillShare } from '@/lib/domain/allocation';
import { formatDurationZh, formatPercent } from '@/lib/format';
import type { AllocationSkill, SkillBucket, SkillInvestmentDto } from '@/lib/types';
import { Card } from '@/components/ui/Card';

/** 展示顺序：四科 + 泛练 + 语言知识（不含 META），最后单独追加复盘行。 */
const DISPLAY_ORDER: SkillBucket[] = [...SKILL_BUCKET_ORDER, 'META'];

/** 支持性桶：不进四技能分母。 */
const SUPPORT_BUCKETS: SkillBucket[] = ['EXTENSIVE', 'VOCAB', 'GRAMMAR', 'SENTENCE', 'META'];

const FOUR_SKILLS: AllocationSkill[] = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];

function isFourSkill(bucket: SkillBucket): bucket is AllocationSkill {
  return (FOUR_SKILLS as SkillBucket[]).includes(bucket);
}

export function SkillInvestment({ data }: { data: SkillInvestmentDto }) {
  const supportTotal = SUPPORT_BUCKETS.reduce((sum, bucket) => sum + data[bucket], 0);

  // 分母只含四技能 —— 本组件的核心口径
  const share = skillShare({
    LISTENING: data.LISTENING,
    READING: data.READING,
    SPEAKING: data.SPEAKING,
    WRITING: data.WRITING,
    FOUNDATION: supportTotal,
  });

  const grandTotal = share.denominator + supportTotal + data.MEDIATED;

  return (
    <Card
      title="四项投入（本周）"
      description="占比分母只含听说读写四项专项训练；词汇、语法、句子成分、泛练、复盘一律单列，不进分母。"
    >
      <ul className="space-y-1">
        {DISPLAY_ORDER.map((bucket) => {
          const minutes = data[bucket];
          const isSupport = SUPPORT_BUCKETS.includes(bucket);
          const isMeta = bucket === 'META';

          // 四技能用四技能分母（分母 0 → null → 展示「—」）；
          // 支持性桶用「支持性时间自身」作参照，避免把 0 误读成「占比 0%」。
          let ratio: number | null;
          if (isFourSkill(bucket)) {
            ratio = share.share[bucket];
          } else {
            ratio = supportTotal > 0 ? minutes / supportTotal : null;
          }

          return (
            <li key={bucket} className="flex items-center gap-2 text-[11px]">
              <span className="w-16 shrink-0 text-inkMuted">{SKILL_BUCKET_LABEL_ZH[bucket]}</span>
              <span className="h-2 flex-1 overflow-hidden rounded bg-line" aria-hidden="true">
                <span
                  className={[
                    'block h-full rounded',
                    isMeta ? 'bg-slate-300' : isSupport ? 'bg-slate-400' : 'bg-brand',
                  ].join(' ')}
                  style={{ width: `${ratio === null ? 0 : Math.min(100, Math.round(ratio * 100))}%` }}
                />
              </span>
              <span className="tabular w-20 shrink-0 text-right text-ink">
                {formatDurationZh(minutes)}
              </span>
              <span className="tabular w-10 shrink-0 text-right text-inkMuted">
                {ratio === null ? '—' : formatPercent(ratio)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-inkMuted">
        四技能合计 {formatDurationZh(share.denominator)}（占比分母）
        · 支持性时间 {formatDurationZh(supportTotal)}（含复盘 {formatDurationZh(data.META)}）不进分母
        · 总计 {formatDurationZh(grandTotal)}
      </p>
      <p className="mt-1 text-[11px] text-inkMuted">
        每个计时段只归属 1 个技能，故与「本周净时长」口径一致；媒介学习时长已按该次主技能计入四技能，不重复计。
        {data.MEDIATED > 0 ? ` 注意：媒介学习桶为 ${formatDurationZh(data.MEDIATED)}，应为 0，请检查数据。` : ''}
      </p>
    </Card>
  );
}
