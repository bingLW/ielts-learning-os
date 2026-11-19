/**
 * `/analytics` → `/weekly?tab=analytics` 的兼容跳转。
 *
 * 分析看板的**唯一实现**在 `/weekly?tab=analytics`（架构 §10 决策 1：导航固定 11 项，
 * 数据分析作为 Tab 而不是第 12 个一级入口）。此前建过的 `/analytics` 直链保留为
 * 服务端跳转，避免书签失效、也避免两份渲染逻辑各走一条。
 *
 * 注意：Next.js 的 `redirect()` 发出的是 **307 临时跳转**，不是 301。
 * 这里刻意用临时跳转 —— 该路由是历史兼容层，将来若撤销不应被浏览器/CDN 长期缓存。
 *
 * 只转发用户**显式写在 URL 上**的筛选项；默认时间窗不落 URL，
 * 否则「近 30 天」会被固化成历史日期。
 */

import { redirect } from 'next/navigation';
import { GLOBAL_FILTER_KEYS } from '@/lib/constants';
import type { RawSearchParams } from '@/lib/queries/filters';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<RawSearchParams>;
}

export default async function AnalyticsRedirectPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const query = new URLSearchParams();
  query.set('tab', 'analytics');
  for (const key of GLOBAL_FILTER_KEYS) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single.trim().length > 0) {
      query.set(key, single.trim());
    }
  }

  redirect(`/weekly?${query.toString()}`);
}
