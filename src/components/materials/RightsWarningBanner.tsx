/**
 * 权属警示横幅（R2）。
 *
 * 只在"来源不明/仅订阅/未确认权属"时出现。文案必须说清三件事：
 * **为什么限制**、**限制到什么程度**（不能导出原文）、**怎么解除**（去补权属）。
 *
 * 做成纯展示组件（无 state、无 action）：横幅本身不该有副作用，
 * 留痕逻辑在 `SourceDetailsBody` 里（那里有 toast 和按钮状态）。
 */

import { Icon } from '@/components/ui/Icon';
import type { MaterialSourceType } from '@/lib/constants';

export interface RightsWarningBannerProps {
  sourceType: MaterialSourceType;
  rightsConfirmed: boolean;
  licenseName: string | null;
}

/** 该来源类型是否受限（与 `MATERIAL_RESTRICTED_SOURCE_TYPES` 的口径一致）。 */
export function isRestrictedSource(
  sourceType: MaterialSourceType,
  rightsConfirmed: boolean,
): boolean {
  return (
    sourceType === 'unknown' || sourceType === 'licensed_subscription' || !rightsConfirmed
  );
}

export function RightsWarningBanner({
  sourceType,
  rightsConfirmed,
  licenseName,
}: RightsWarningBannerProps) {
  if (!isRestrictedSource(sourceType, rightsConfirmed)) return null;

  const reasons: string[] = [];
  if (sourceType === 'unknown') reasons.push('来源类型为「不确定」，无法判断转载/引用权限');
  if (sourceType === 'licensed_subscription') reasons.push('来自订阅制数据库，通常禁止导出与再分发');
  if (!rightsConfirmed) reasons.push('还没有确认过你拥有使用这份材料的权利');

  return (
    <div className="rounded-md border border-egRed/50 bg-egRed/10 p-2.5">
      <div className="flex items-start gap-1.5">
        <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-egRed" />
        <div className="min-w-0 space-y-1">
          <p className="text-[12px] font-medium text-ink">受限材料：仅供个人学习，禁止导出原文</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-ink">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {licenseName && (
            <p className="text-[11px] text-inkMuted">已登记许可证：{licenseName}</p>
          )}
          <p className="text-[11px] text-inkMuted">
            补全来源信息并确认权属后，限制会自动解除。每次点击导出都会留痕（可审计）。
          </p>
        </div>
      </div>
    </div>
  );
}
