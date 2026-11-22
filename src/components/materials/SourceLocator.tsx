/**
 * 来源登记与版权限制（R1/R2）。
 *
 * 为什么单独一个组件：**来源信息必须出现在任何"AI 衍生内容"附近的固定位置**，
 * 而不是散落在各页面的脚注里。页面只需要 `<SourceLocator source={...} />`，
 * 排版与措辞就不会出现两个版本。
 *
 * `restrictedExport` 由查询层算好（`sourceType ∈ unknown | licensed_subscription`），
 * 组件不再自己判断 —— 版权规则的唯一来源是常量表。
 */

import { Icon } from '@/components/ui/Icon';
import {
  MATERIAL_SOURCE_TYPE_LABELS_ZH,
  type MaterialSourceType,
} from '@/lib/constants';
import type { MaterialSourceDto } from '@/lib/queries/materials';

export interface SourceLocatorProps {
  source: MaterialSourceDto | null;
  className?: string;
}

export function SourceLocator({ source, className }: SourceLocatorProps) {
  if (!source) {
    return (
      <p className={['text-[11px] text-inkMuted', className].filter(Boolean).join(' ')}>
        这份材料还没有登记来源。建议在处理页补登来源，便于日后判断能否引用与导出。
      </p>
    );
  }

  const label = MATERIAL_SOURCE_TYPE_LABELS_ZH[source.sourceType as MaterialSourceType] ?? '未知';
  const metaParts: string[] = [];
  if (source.author) metaParts.push(source.author);
  if (source.publisher) metaParts.push(source.publisher);
  if (source.publishedYear !== null) metaParts.push(`${source.publishedYear}`);

  return (
    <div
      className={[
        'rounded-lg border border-line bg-surfaceAlt p-2.5 text-[11px] leading-relaxed text-ink',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">来源</span>
        <span className="rounded border border-line bg-surface px-1 py-0.5 text-[10px] text-inkMuted">
          {label}
        </span>
        {source.rightsConfirmed && (
          <span className="rounded border border-egGreen/40 bg-egGreen/10 px-1 py-0.5 text-[10px]">
            已完成用途确认
          </span>
        )}
      </p>

      {metaParts.length > 0 && <p className="mt-0.5 text-inkMuted">{metaParts.join(' · ')}</p>}

      {source.url && (
        <p className="mt-0.5 break-all text-inkMuted">
          链接：
          <span className="text-ink">{source.url}</span>
        </p>
      )}

      {(source.licenseName || source.licenseUrl) && (
        <p className="mt-0.5 text-inkMuted">
          许可：
          <span className="text-ink">{source.licenseName ?? source.licenseUrl}</span>
        </p>
      )}

      {source.userNote && <p className="mt-0.5 text-inkMuted">备注：{source.userNote}</p>}

      {source.restrictedExport && (
        <p className="mt-1 flex items-start gap-1 rounded border border-egYellow/50 bg-egYellow/10 p-1.5">
          <Icon name="alert" size={12} />
          <span>
            受限来源：仅供你个人学习使用，<strong className="font-semibold">不能导出、不能分享</strong>，也不建议把原文贴到别处。
          </span>
        </p>
      )}
    </div>
  );
}
