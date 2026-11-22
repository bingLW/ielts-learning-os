'use client';

/**
 * 材料库筛选条。
 *
 * 用 URL 查询参数驱动（`/materials?status=failed`），不做客户端过滤 ——
 * 材料可能有几百条，交给 SQL 更稳，且刷新/分享链接都能保住筛选条件。
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { inputClass, selectClass } from '@/components/ui/FormField';
import {
  MATERIAL_FORMATS,
  MATERIAL_FORMAT_LABELS_ZH,
  MATERIAL_SOURCE_TYPES,
  MATERIAL_SOURCE_TYPE_LABELS_ZH,
  MATERIAL_STATUSES,
  MATERIAL_STATUS_LABELS_ZH,
} from '@/lib/constants';

export function MaterialFilterBar() {
  const router = useRouter();
  const params = useSearchParams();
  const [keyword, setKeyword] = useState(params.get('q') ?? '');

  const push = useCallback(
    (next: Record<string, string>) => {
      const search = new URLSearchParams();
      const status = next.status ?? params.get('status') ?? '';
      const format = next.format ?? params.get('format') ?? '';
      const sourceType = next.sourceType ?? params.get('sourceType') ?? '';
      const q = next.q ?? params.get('q') ?? '';
      if (status) search.set('status', status);
      if (format) search.set('format', format);
      if (sourceType) search.set('sourceType', sourceType);
      if (q) search.set('q', q);
      const query = search.toString();
      router.push(query ? `/materials?${query}` : '/materials');
    },
    [params, router],
  );

  const reset = (): void => {
    setKeyword('');
    router.push('/materials');
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-inkMuted">状态</span>
        <select
          className={`${selectClass} w-28 text-xs`}
          value={params.get('status') ?? ''}
          onChange={(event) => push({ status: event.target.value })}
        >
          <option value="">全部</option>
          {MATERIAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {MATERIAL_STATUS_LABELS_ZH[status]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-inkMuted">格式</span>
        <select
          className={`${selectClass} w-24 text-xs`}
          value={params.get('format') ?? ''}
          onChange={(event) => push({ format: event.target.value })}
        >
          <option value="">全部</option>
          {MATERIAL_FORMATS.map((format) => (
            <option key={format} value={format}>
              {MATERIAL_FORMAT_LABELS_ZH[format]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-inkMuted">来源</span>
        <select
          className={`${selectClass} w-36 text-xs`}
          value={params.get('sourceType') ?? ''}
          onChange={(event) => push({ sourceType: event.target.value })}
        >
          <option value="">全部</option>
          {MATERIAL_SOURCE_TYPES.map((sourceType) => (
            <option key={sourceType} value={sourceType}>
              {MATERIAL_SOURCE_TYPE_LABELS_ZH[sourceType]}
            </option>
          ))}
        </select>
      </label>

      <form
        className="flex flex-1 items-end gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          push({ q: keyword.trim() });
        }}
      >
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-inkMuted">标题关键词</span>
          <input
            className={`${inputClass} text-xs`}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="例如 reading"
          />
        </label>
        <Button type="submit" size="sm">
          筛选
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          重置
        </Button>
      </form>
    </div>
  );
}
