/**
 * v2.1 端到端验收（真实数据副本）。
 *
 * 链路：设定预算 → 生成计划 → 记录实际 → 改预算 → 中途重排 → 周报。
 *
 * 安全边界：
 * - 先 `cp prisma/dev.db` 到临时副本，`DATABASE_URL` 指向副本；
 * - 真实库只读，任何写入都落在副本，跑完删除。
 *
 * 之所以不直接调用 Server Action：`revalidatePath` 需要 Next 请求上下文，
 * 在脚本里会抛错。这里复现动作层的写入序列（同样的域函数 + 同样的字段），
 * 校验的是**引擎与数据不变量**，而不是 HTTP 层。
 */

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const sourceDb = join(repoRoot, 'prisma', 'dev.db');
const workDb = join(tmpdir(), `ielts-e2e-${Date.now()}.db`);

if (!existsSync(sourceDb)) {
  console.error(`[FAIL] 找不到真实数据库：${sourceDb}`);
  process.exit(1);
}
copyFileSync(sourceDb, workDb);
process.env.DATABASE_URL = `file:${workDb}`;

const { PrismaClient } = await import('@prisma/client');
const { generateAdaptivePlan } = await import('../src/lib/domain/adaptivePlan');
const { replanDailyTasks } = await import('../src/lib/domain/replan');
const { today, weekRange, listDateRange, addDays, isoWeek: isoWeekOf } = await import('../src/lib/date');
const { getBudgetRange } = await import('../src/lib/queries/budget');
const { getWeeklyBudget } = await import('../src/lib/queries/weekly');

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 复现动作层的写入序列：预算 upsert + 任务 createMany + 版本审计。 */
async function commitPlan(params: {
  planDate: string;
  stageId: string;
  budgetMinutes: number;
  isRestDay: boolean;
  items: { module: string; skill: string; minutes: number; sortOrder: number; track: string; primarySkill: string; priority: string; sourceKind: string; splittable: boolean; minChunkMinutes: number }[];
  version: number;
  changeSource: string;
  actualAtChange: number;
}) {
  const { planDate, stageId, budgetMinutes, isRestDay, items, version, changeSource, actualAtChange } = params;
  return prisma.$transaction(async (tx) => {
    await tx.dailyBudget.upsert({
      where: { date: planDate },
      create: {
        date: planDate,
        plannedAvailableMinutes: budgetMinutes,
        isRestDay,
        budgetType: isRestDay ? 'REST_DAY' : 'CUSTOM',
        source: 'USER',
        isInitialSuggestion: false,
      },
      update: {
        plannedAvailableMinutes: budgetMinutes,
        isRestDay,
        budgetType: isRestDay ? 'REST_DAY' : 'CUSTOM',
        source: 'USER',
        isInitialSuggestion: false,
      },
    });
    if (items.length > 0) {
      await tx.planTask.createMany({
        data: items.map((item) => ({
          planDate,
          stageId,
          module: item.module,
          skill: item.skill,
          track: item.track,
          primarySkill: item.primarySkill,
          plannedMinutes: item.minutes,
          actualMinutes: 0,
          sortOrder: item.sortOrder,
          status: 'TODO',
          priority: item.priority,
          sourceKind: item.sourceKind,
          splittable: item.splittable,
          minChunkMinutes: item.minChunkMinutes,
          planVersion: version,
          originalScheduledDate: planDate,
        })),
      });
    }
    await tx.planVersion.create({
      data: {
        planDate,
        version,
        changeSource,
        budgetMinutes,
        actualMinutesAtChange: actualAtChange,
      },
    });
  });
}

async function main() {
  const planDate = today();
  console.log(`\n=== v2.1 E2E · 计划日期 ${planDate}（数据库副本）===\n`);

  const stage = await prisma.stage.findFirst({ where: { status: 'ACTIVE' } });
  check('存在激活阶段', Boolean(stage), stage ? `${stage.code}` : '无');
  if (!stage) throw new Error('没有激活阶段，无法继续');
  const stageCode = stage.code as 'S0_PREP' | 'S1_A0_A2' | 'S2_A2_B1' | 'S3_B1_IELTS';

  // 清掉副本里目标日的既有任务，让链路从「空日」开始（仅副本）
  await prisma.planTask.deleteMany({ where: { planDate } });
  await prisma.planVersion.deleteMany({ where: { planDate } });

  // ── ① 设定预算 ───────────────────────────────────────────
  console.log('\n[1] 设定预算 90 分钟');
  await prisma.dailyBudget.upsert({
    where: { date: planDate },
    create: {
      date: planDate,
      plannedAvailableMinutes: 90,
      budgetType: 'CUSTOM',
      source: 'USER',
      isInitialSuggestion: false,
    },
    update: {
      plannedAvailableMinutes: 90,
      budgetType: 'CUSTOM',
      source: 'USER',
      isInitialSuggestion: false,
      isRestDay: false,
    },
  });
  const budgetAfterSet = await getBudgetRange([planDate]);
  const b1 = budgetAfterSet.get(planDate);
  check('预算解析为 90', b1?.minutes === 90, `${b1?.minutes}`);
  check('来源标记为用户设定', b1?.source === 'USER', `${b1?.source}`);
  check('不再是「建议值」', b1?.isSuggestion === false);

  // ── ② 生成计划 ───────────────────────────────────────────
  console.log('\n[2] 按 90 分钟预算生成计划');
  const planResult = generateAdaptivePlan({
    budgetMinutes: 90,
    stageCode,
    dueReviews: { estMinutes: 0, count: 0, maxOverdueDays: 0 },
    minTaskMinutes: 5,
  });
  check('生成成功', planResult.ok);
  if (!planResult.ok) throw new Error(`生成失败：${planResult.error}`);

  const total = planResult.items.reduce((sum, item) => sum + item.minutes, 0);
  check('计划总分钟 ≤ 预算', total <= 90, `${total} ≤ 90`);
  check('没有低于最小粒度的任务', planResult.items.every((i) => i.minutes >= 5));
  check(
    '没有碎片化任务（<20 分钟占比不高）',
    planResult.items.filter((i) => i.minutes < 20).length <= 2,
    `${planResult.items.filter((i) => i.minutes < 20).length} 个`,
  );

  await commitPlan({
    planDate,
    stageId: stage.id,
    budgetMinutes: 90,
    isRestDay: false,
    items: planResult.items.map((i) => ({
      module: i.module,
      skill: i.skill,
      minutes: i.minutes,
      sortOrder: i.sortOrder,
      track: i.track,
      primarySkill: i.primarySkill,
      priority: i.priority,
      sourceKind: i.sourceKind,
      splittable: i.splittable,
      minChunkMinutes: i.minChunkMinutes,
    })),
    version: 1,
    changeSource: 'GENERATE',
    actualAtChange: 0,
  });

  const tasksAfterGenerate = await prisma.planTask.findMany({ where: { planDate } });
  check('任务已落库', tasksAfterGenerate.length === planResult.items.length, `${tasksAfterGenerate.length} 条`);
  check('全部 planVersion=1', tasksAfterGenerate.every((t) => t.planVersion === 1));

  // ── ③ 记录实际（模拟完成一个任务 + 一段媒介学习）────────
  console.log('\n[3] 记录实际学习：完成首任务 30 分钟 + 不挂任务的 10 分钟');
  const firstTask = tasksAfterGenerate.sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const doneMinutes = 30;
  await prisma.planTask.update({
    where: { id: firstTask.id },
    data: { status: 'DONE', actualMinutes: doneMinutes, statusChangedAt: new Date() },
  });
  const session = await prisma.studySession.create({
    data: {
      task: { connect: { id: firstTask.id } },
      startedAt: new Date(`${planDate}T09:00:00+08:00`),
      endedAt: new Date(`${planDate}T09:30:00+08:00`),
      activeMinutes: doneMinutes,
      terminatedReason: 'COMPLETED',
      sessionDate: planDate,
      skill: firstTask.skill,
      track: firstTask.track,
    },
  });
  await prisma.studySessionDaySplit.create({
    data: { sessionId: session.id, date: planDate, minutes: doneMinutes },
  });
  const mediatedSession = await prisma.studySession.create({
    data: {
      startedAt: new Date(`${planDate}T10:00:00+08:00`),
      endedAt: new Date(`${planDate}T10:10:00+08:00`),
      activeMinutes: 10,
      terminatedReason: 'COMPLETED',
      sessionDate: planDate,
      skill: 'LISTENING',
      track: 'ENGLISH_MEDIATED_LEARNING',
    },
  });
  await prisma.studySessionDaySplit.create({
    data: { sessionId: mediatedSession.id, date: planDate, minutes: 10 },
  });

  const netAgg = await prisma.studySessionDaySplit.aggregate({
    where: { date: planDate },
    _sum: { minutes: true },
  });
  const actualToday = netAgg._sum.minutes ?? 0;
  check('当日净时长为 40（30+10）', actualToday === 40, `${actualToday}`);
  check(
    '净时长包含不挂任务的学习段',
    actualToday > tasksAfterGenerate.reduce((s, t) => s + t.actualMinutes, 0),
  );

  // ── ④ 改预算 ─────────────────────────────────────────────
  console.log('\n[4] 中途把预算改为 40 分钟');
  const newBudget = 40;
  await prisma.dailyBudget.update({
    where: { date: planDate },
    data: { plannedAvailableMinutes: newBudget, budgetType: 'CUSTOM', source: 'USER' },
  });
  const b4 = (await getBudgetRange([planDate])).get(planDate);
  check('预算已变为 40', b4?.minutes === 40, `${b4?.minutes}`);

  // ── ⑤ 重新规划 ───────────────────────────────────────────
  console.log('\n[5] 按新预算重排（保留已完成，只重排未开始）');
  const existingRows = await prisma.planTask.findMany({
    where: { planDate },
    orderBy: { sortOrder: 'asc' },
  });
  const maxVersion = Math.max(...existingRows.map((r) => r.planVersion), 1);
  const nextVersion = maxVersion + 1;

  const replanResult = replanDailyTasks({
    existingTasks: existingRows.map((row) => ({
      id: row.id,
      module: row.module,
      skill: row.skill,
      plannedMinutes: row.plannedMinutes,
      actualMinutes: row.actualMinutes,
      status: row.status as never,
      priority: row.priority as never,
      sourceKind: row.sourceKind as never,
      splittable: row.splittable,
      minChunkMinutes: row.minChunkMinutes,
      sortOrder: row.sortOrder,
      planVersion: row.planVersion,
      timerRunning: row.timerStatus === 'RUNNING',
      track: row.track,
      primarySkill: row.primarySkill,
      resourceId: row.resourceId,
      note: row.note,
    })),
    newBudgetMinutes: newBudget,
    planInput: {
      stageCode,
      dueReviews: { estMinutes: 0, count: 0, maxOverdueDays: 0 },
      minTaskMinutes: 5,
    },
    nextVersion,
    actualMinutesToday: actualToday,
  });

  check('重排成功', replanResult.ok);
  if (!replanResult.ok) throw new Error(`重排失败：${replanResult.error}`);

  const keepActions = replanResult.actions.filter((a) => a.type === 'KEEP');
  const deferActions = replanResult.actions.filter((a) => a.type === 'DEFER');
  const finishedBefore = existingRows.filter((t) => t.status === 'DONE' || t.status === 'PARTIAL');

  check(
    '所有已完成任务都被 KEEP（事实不被改写）',
    finishedBefore.every((t) => keepActions.some((a) => a.taskId === t.id)),
    `${finishedBefore.length} 条已完成`,
  );
  check(
    '重排没有 DELETE 动作（保护计时段外键）',
    replanResult.actions.every((a) => a.type !== ('DELETE' as never)),
  );
  check(
    '剩余预算 = 新预算 − 已发生 = 0',
    replanResult.remainingBudgetMinutes === 0,
    `${replanResult.remainingBudgetMinutes}`,
  );
  check(
    '已发生 40 分钟被记住',
    replanResult.actualMinutesSnapshot === 40,
    `${replanResult.actualMinutesSnapshot}`,
  );
  check(
    '预算已被学习时间耗尽，不再产生新任务',
    replanResult.newTasks.length === 0,
    `${replanResult.newTasks.length} 条新任务`,
  );
  check('未开始的任务被延期而非删除', deferActions.length > 0, `${deferActions.length} 条延期`);

  // 提交重排结果（复现动作层写入）
  await prisma.$transaction(async (tx) => {
    for (const action of replanResult.actions) {
      if (action.type === 'DEFER') {
        await tx.planTask.update({
          where: { id: action.taskId },
          data: { status: 'DEFERRED', deferReason: '预算下调后不再排入当日' },
        });
      }
    }
    if (replanResult.newTasks.length > 0) {
      await tx.planTask.createMany({
        data: replanResult.newTasks.map((t) => ({
          planDate,
          stageId: stage.id,
          module: t.module,
          skill: t.skill,
          track: t.track,
          primarySkill: t.primarySkill,
          plannedMinutes: t.plannedMinutes,
          sortOrder: t.sortOrder,
          status: 'TODO',
          priority: t.priority,
          sourceKind: t.sourceKind,
          splittable: t.splittable,
          minChunkMinutes: t.minChunkMinutes,
          planVersion: t.planVersion,
          originalScheduledDate: planDate,
        })),
      });
    }
    await tx.planVersion.create({
      data: {
        planDate,
        version: nextVersion,
        changeSource: 'REPLAN',
        budgetMinutes: newBudget,
        actualMinutesAtChange: actualToday,
        reason: 'E2E：中途下调预算',
        idempotencyKey: `e2e-${planDate}-replan`,
      },
    });
  });

  const tasksAfterReplan = await prisma.planTask.findMany({ where: { planDate } });
  const doneAfter = tasksAfterReplan.filter((t) => t.status === 'DONE');
  check(
    '已完成任务重排后仍是 DONE 且实际分钟不变',
    doneAfter.length === finishedBefore.length &&
      doneAfter.every((t) => t.actualMinutes === doneMinutes),
    `${doneAfter.length} 条，实际 ${doneAfter.map((t) => t.actualMinutes).join(',')}`,
  );
  const splitsAfter = await prisma.studySessionDaySplit.aggregate({
    where: { date: planDate },
    _sum: { minutes: true },
  });
  check('重排未改动历史净时长', (splitsAfter._sum.minutes ?? 0) === 40, `${splitsAfter._sum.minutes}`);

  // 幂等重放
  const replay = await prisma.planVersion.findUnique({
    where: { idempotencyKey: `e2e-${planDate}-replan` },
  });
  check('重排版本已记录且幂等键唯一', replay?.version === nextVersion, `v${replay?.version}`);

  // ── ⑥ 周报 ───────────────────────────────────────────────
  console.log('\n[6] 周报预算对照');
  const { isoYear, isoWeek } = isoWeekOf(planDate);
  const budget = await getWeeklyBudget(isoYear, isoWeek);
  const dayRow = budget.days.find((d) => d.date === planDate);

  check('周报覆盖完整 7 天', budget.days.length === 7, `${budget.days.length}`);
  check('周报预算合计 > 0', budget.budgetTotalMinutes > 0, `${budget.budgetTotalMinutes}`);
  check('周报实际合计 ≥ 40', budget.netTotalMinutes >= 40, `${budget.netTotalMinutes}`);
  check('目标日预算反映最新值 40', dayRow?.budgetMinutes === 40, `${dayRow?.budgetMinutes}`);
  check('目标日实际净时长 40', dayRow?.netMinutes === 40, `${dayRow?.netMinutes}`);
  check('重排次数被统计入周报', budget.replanCount >= 1, `${budget.replanCount}`);
  check(
    '预算利用率计算有限（预算>0 时）',
    budget.budgetTotalMinutes === 0 ||
      Number.isFinite(
        Math.round((budget.netTotalMinutes / budget.budgetTotalMinutes) * 100),
      ),
  );

  const { weekStart } = weekRange(planDate);
  const dates = listDateRange(weekStart, addDays(weekStart, 6));
  check('周范围是 7 天', dates.length === 7);
}

try {
  await main();
} catch (error) {
  failed += 1;
  failures.push(String(error));
  console.error('\n[ERROR]', error);
} finally {
  await prisma.$disconnect();
  try {
    rmSync(workDb, { force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  console.log(`\n════════ 结果：${passed} 通过 / ${failed} 失败 ════════`);
  if (failures.length > 0) {
    console.log('\n失败项：');
    for (const item of failures) console.log(`  - ${item}`);
  }
  console.log(`真实库未被修改：${sourceDb}`);
  process.exit(failed > 0 ? 1 : 0);
}
