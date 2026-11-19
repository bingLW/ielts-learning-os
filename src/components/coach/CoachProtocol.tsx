'use client';

/**
 * Coach 协议步骤条：先自己尝试，再诊断、提示、练习、复测、更新证据。
 *
 * 这是教学协议，不是计分器；每一步都可以回到对应页面留下证据。
 */

import { useState } from 'react';
import {
  COACH_STEP_GUIDE_ZH,
  COACH_STEP_LABEL_ZH,
  COACH_STEPS,
} from '@/lib/constants';
import type { CoachStep } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { nextCoachStep, previousCoachStep } from '@/lib/domain/coach';

const STEP_LINK: Record<CoachStep, { href: string; label: string }> = {
  ATTEMPT: { href: '/evidence', label: '去 Evidence Center 记录 A0 尝试' },
  DIAGNOSE: { href: '/diagnosis', label: '去诊断页记录障碍' },
  HINT: { href: '#ai-usage', label: '记录一次 AI 提示' },
  PRACTICE: { href: '/plan', label: '查看今日计划' },
  RETEST: { href: '/evidence', label: '去记录复测证据' },
  EVIDENCE: { href: '/profile', label: '更新分项画像' },
};

export function CoachProtocol() {
  const [step, setStep] = useState<CoachStep>('ATTEMPT');
  const index = COACH_STEPS.indexOf(step);
  const next = nextCoachStep(step);
  const prev = previousCoachStep(step);

  return (
    <Card
      title="Coach 协议 · 一轮 6 步"
      description="AI 只在第 3 步之后介入；任何 AI 改写都不能替代你的独立产出。"
    >
      <ol className="flex flex-wrap gap-1">
        {COACH_STEPS.map((item, i) => {
          const active = item === step;
          const done = i < index;
          return (
            <li key={item}>
              <button
                type="button"
                onClick={() => setStep(item)}
                aria-current={active ? 'step' : undefined}
                className={[
                  'rounded border px-2 py-1 text-[11px]',
                  active
                    ? 'border-brand bg-blue-50 font-medium text-brand'
                    : done
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-line bg-surface text-inkMuted',
                ].join(' ')}
              >
                {COACH_STEP_LABEL_ZH[item]}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-2 rounded border border-line bg-surfaceAlt p-2">
        <p className="text-[12px] font-medium text-ink">{COACH_STEP_LABEL_ZH[step]}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-inkMuted">
          {COACH_STEP_GUIDE_ZH[step]}
        </p>
        <a className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand underline" href={STEP_LINK[step].href}>
          {STEP_LINK[step].label}
          <Icon name="external" size={11} />
        </a>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!prev}
          onClick={() => prev && setStep(prev)}
        >
          上一步
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!next}
          onClick={() => next && setStep(next)}
        >
          {next ? '下一步' : '本轮完成'}
        </Button>
      </div>
    </Card>
  );
}
