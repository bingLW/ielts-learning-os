/**
 * 规划器空状态：强制写清「本页依赖哪些前置数据」并给出直达入口。
 *
 * 与通用 `ui/EmptyState` 的差别只有一处：主行动固定为「先做一轮诊断」，
 * 次行动固定为证据中心 —— v2.7 全部规划页面只缺这两种前置数据。
 */

import { EmptyState } from '@/components/ui/EmptyState';

export function PlannerEmptyState({
  title,
  description,
  dependencies,
  primaryHref = '/diagnostics',
  primaryLabel = '先做一轮诊断',
}: {
  title: string;
  description?: string;
  dependencies: string[];
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <EmptyState
      icon="target"
      title={title}
      description={description}
      dependencies={dependencies}
      primary={{ label: primaryLabel, href: primaryHref }}
      secondary={{ label: '查看证据中心', href: '/evidence' }}
    />
  );
}