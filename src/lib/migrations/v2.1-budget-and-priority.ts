/**
 * v2.1 数据迁移：预算、优先级、计划版本。
 *
 * 执行时机：应用启动时检测 `PlannerSettings` 不存在则自动运行；
 * 也可由设置页手动触发（显示「v2.1 迁移完成」提示）。
 *
 * 幂等性：已运行过的不会重复执行（检查 `PlannerSettings` 是否存在）。
 *
 * 迁移内容：
 * 1. 创建 `PlannerSettings` 单行（id=1）：`defaultDailyMinutes=60`，
 *    `weekdayProfiles` 初始化为周一～周六 60 分钟、周日休息；
 * 2. 回填历史 `PlanTask` 的 `sourceKind = LEGACY` 与 `originalScheduledDate = planDate`；
 * 3. 不自动创建 `DailyBudget` 行（避免把「60 分钟建议」当成真实可用时间）：
 *    用户首次打开计划页时由 UI 引导选择档次，选择后才写入 `DailyBudget`。
 */

import { prisma } from '@/lib/prisma';

/**
 * 迁移主入口（幂等）。
 *
 * @returns 本次是否执行了迁移（`true` = 首次运行；`false` = 已迁移过，跳过）
 */
export async function migrateV21BudgetAndPriority(): Promise<{
  migrated: boolean;
  message: string;
}> {
  const existing = await prisma.plannerSettings.findUnique({ where: { id: 1 } });
  if (existing) {
    return { migrated: false, message: 'v2.1 迁移已完成（幂等跳过）' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.plannerSettings.create({
      data: {
        id: 1,
        defaultDailyMinutes: 60,
        weekdayProfiles: JSON.stringify([60, 60, 60, 60, 60, 60, 0]),
        minTaskMinutes: 5,
        weeklyTargetMinutes: null,
        priorityPolicy: JSON.stringify({ p0CapRatio: 0.6, coreMinRatio: 0.3 }),
      },
    });

    const legacyTasks = await tx.planTask.findMany({
      where: { sourceKind: 'CORE', originalScheduledDate: null },
      select: { id: true, planDate: true },
    });

    if (legacyTasks.length > 0) {
      await Promise.all(
        legacyTasks.map((task) =>
          tx.planTask.update({
            where: { id: task.id },
            data: {
              sourceKind: 'LEGACY',
              originalScheduledDate: task.planDate,
            },
          }),
        ),
      );
    }
  });

  return {
    migrated: true,
    message: `v2.1 迁移完成（回填 ${await countLegacyTasks()} 条历史任务）`,
  };
}

async function countLegacyTasks(): Promise<number> {
  return prisma.planTask.count({ where: { sourceKind: 'LEGACY' } });
}

/**
 * 检查是否已完成 v2.1 迁移（供应用启动时调用）。
 */
export async function isV21Migrated(): Promise<boolean> {
  const settings = await prisma.plannerSettings.findUnique({ where: { id: 1 } });
  return Boolean(settings);
}
