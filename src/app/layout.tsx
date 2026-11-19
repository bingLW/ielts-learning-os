/**
 * 根布局：外壳 + 字体 + 全局样式。
 *
 * 外壳需要读 `UserProfile` 与 `ActiveStage`，但**不能让读库失败把整个应用打挂**
 * （例如首次进入、数据库尚未 seed）。因此这里做降级：读不到就用默认值渲染外壳，
 * 页面本身再各自处理空态。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { today } from '@/lib/date';
import { getActiveStage } from '@/lib/queries/stages';
import { getProfile } from '@/lib/queries/profile';
import { getEffectiveBudget } from '@/lib/queries/budget';
import AppShell from '@/components/layout/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'IELTS Learning OS · 学习闭环工作台',
  description:
    '单用户英语学习管理工作台：计划 → 执行 → 记录 → 评估 → 错题复习 → 分析 → 验收 → 下一阶段。',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let stageName = '尚未激活阶段';
  let targetBand = 6.5;
  let budgetLabel = '预算未设定';

  try {
    const [profile, stage, budget] = await Promise.all([
      getProfile(),
      getActiveStage(),
      getEffectiveBudget(),
    ]);
    stageName = stage?.nameZh ?? stageName;
    targetBand = profile.targetBandOverall;
    budgetLabel = budget.isRestDay
      ? '今日休息'
      : `今日预算 ${budget.minutes} 分${budget.isSuggestion ? '（建议）' : ''}`;
  } catch {
    // 数据库尚未初始化时仍然渲染外壳，页面内会给出空态与引导
  }

  return (
    <html lang="zh-CN">
      <body>
        <AppShell
          todayStr={today()}
          stageName={stageName}
          targetBand={targetBand}
          budgetLabel={budgetLabel}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
