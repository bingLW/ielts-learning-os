/**
 * 全局筛选条（T32）。
 *
 * 原生 GET 表单：不依赖 JS，提交即刷新 URL；服务端读 searchParams 下推到 SQL。
 */

import Link from 'next/link';
import { ANALYTICS_WINDOW_DAYS } from '@/lib/constants';
import { addDays, today } from '@/lib/date';
import type { GlobalFilterDto, GlobalFilterOptionsDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';

export interface FilterBarProps {
  filter: GlobalFilterDto;
  options: GlobalFilterOptionsDto;
}

export function FilterBar({ filter, options }: FilterBarProps) {
  const nowDate = today();
  const last30 = addDays(nowDate, -(ANALYTICS_WINDOW_DAYS - 1));

  return (
    <form method="get" className="grid gap-2 mobile:grid-cols-2 md:grid-cols-5">
      {/*
        分析看板是 `/weekly?tab=analytics` 的 Tab（架构 §10-1）。
        原生 GET 表单提交后会丢掉未出现在表单里的 query 参数，所以必须显式带上 `tab`，
        否则点「应用筛选」会被弹回周复盘 Tab —— 这是最容易被忽略的一处。
      */}
      <input type="hidden" name="tab" value="analytics" />
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        起始日期
        <input
          type="date"
          name="from"
          defaultValue={filter.from}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        结束日期
        <input
          type="date"
          name="to"
          defaultValue={filter.to}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        阶段
        <select
          name="stageId"
          defaultValue={filter.stageId ?? ''}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        >
          <option value="">全部阶段</option>
          {options.stages.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        科目
        <select
          name="skill"
          defaultValue={filter.skill ?? ''}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        >
          <option value="">全部科目</option>
          {options.skills.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-inkMuted">
        教材 / 资源
        <select
          name="resourceId"
          defaultValue={filter.resourceId ?? ''}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
        >
          <option value="">全部资源</option>
          {options.resources.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-end gap-2 mobile:col-span-2 md:col-span-5">
        <Button variant="primary" size="sm" type="submit">
          应用筛选
        </Button>
        <Link
          href={`/weekly?tab=analytics&from=${last30}&to=${nowDate}`}
          className="text-[11px] text-brand underline"
        >
          近 {ANALYTICS_WINDOW_DAYS} 天
        </Link>
        <Link href="/weekly?tab=analytics" className="text-[11px] text-brand underline">
          重置
        </Link>
      </div>
    </form>
  );
}
