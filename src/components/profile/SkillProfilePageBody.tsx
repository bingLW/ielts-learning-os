'use client';

/**
 * 能力画像页主体：四项技能各自一张卡，不使用平均分、不换算官方等级。
 */

import { PROFILE_NO_AVERAGE_NOTE } from '@/lib/constants';
import type { SkillProfileRowDto } from '@/lib/types';
import { Toast, useToastState } from '@/components/ui/Toast';
import { SkillProfileCard } from './SkillProfileCard';

export function SkillProfilePageBody({ rows }: { rows: SkillProfileRowDto[] }) {
  const { toast, show, dismiss } = useToastState();

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">能力画像</h1>
        <p className="text-xs text-inkMuted">
          听力 / 阅读 / 口语 / 写作分开判断 · 置信度来自证据结构，不是学习时长
        </p>
        <p className="mt-1 rounded border border-line bg-surfaceAlt p-2 text-[11px] text-inkMuted">
          {PROFILE_NO_AVERAGE_NOTE}
        </p>
      </div>

      {rows.map((row) => (
        <SkillProfileCard key={row.skill} row={row} onToast={show} />
      ))}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
