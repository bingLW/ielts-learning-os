/**
 * 记录筛选器。
 *
 * 用原生 `<form method="get">`：筛选条件进 URL，服务端渲染，无客户端状态，
 * 刷新/分享/回退都稳。变更后全量重算（与 PRD §5.10 的筛选语义一致）。
 */

import { SKILL_IDS, SKILL_LABEL_ZH } from '@/lib/constants';
import { buttonClass } from '@/components/ui/Button';
import { inputClass } from '@/components/ui/FormField';

export interface RecordFiltersProps {
  skill?: string;
  stageId?: string;
  resourceId?: string;
  fromDate?: string;
  toDate?: string;
  stages: { id: string; nameZh: string }[];
  resources: { id: string; name: string }[];
}

export function RecordFilters({
  skill,
  stageId,
  resourceId,
  fromDate,
  toDate,
  stages,
  resources,
}: RecordFiltersProps) {
  return (
    <form method="get" action="/records" className="flex flex-wrap items-end gap-1.5">
      <label className="flex flex-col gap-0.5 text-[11px] text-inkMuted">
        科目
        <select name="skill" defaultValue={skill ?? ''} className={`${inputClass} py-1 text-xs`}>
          <option value="">全部</option>
          {SKILL_IDS.map((item) => (
            <option key={item} value={item}>
              {SKILL_LABEL_ZH[item]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5 text-[11px] text-inkMuted">
        阶段
        <select name="stageId" defaultValue={stageId ?? ''} className={`${inputClass} py-1 text-xs`}>
          <option value="">全部</option>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.nameZh}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5 text-[11px] text-inkMuted">
        资源
        <select
          name="resourceId"
          defaultValue={resourceId ?? ''}
          className={`${inputClass} py-1 text-xs`}
        >
          <option value="">全部</option>
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5 text-[11px] text-inkMuted">
        从
        <input
          type="date"
          name="fromDate"
          defaultValue={fromDate ?? ''}
          className={`${inputClass} py-1 text-xs`}
        />
      </label>

      <label className="flex flex-col gap-0.5 text-[11px] text-inkMuted">
        到
        <input
          type="date"
          name="toDate"
          defaultValue={toDate ?? ''}
          className={`${inputClass} py-1 text-xs`}
        />
      </label>

      <button type="submit" className={buttonClass('secondary', 'sm')}>
        筛选
      </button>
    </form>
  );
}
