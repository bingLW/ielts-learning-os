/**
 * `/` Dashboard 总览（12 个区块）。
 *
 * 区块清单（与 PRD §5.1 一一对应，编号仅用于验收核对）：
 *  ⓿三目标卡(v2.0 新增) ①状态条 ②四类量分区 ③今日 ④本周
 *  ⑤四项投入 ⑥语法与词汇 ⑦待复习 ⑧7/30 天趋势 ⑨薄弱点 Top3 ⑩下一阶段验收完成度
 *
 * v2.0：⓿ 三目标卡是三条轨道的入口。三者**各自独立**，页面上不出现任何「总能力分」。
 *
 * 约束：本页所有数字均来自 `getDashboard()` 的数据库聚合，页面里没有任何硬编码统计值。
 */

import Link from 'next/link';
import type { GateResult } from '@/lib/types';
import { businessToday, getBusinessTimezone } from '@/lib/businessTime';
import { getDashboard } from '@/lib/queries/dashboard';
import { getGoalCards } from '@/lib/queries/goals';
import { getVocabDashboardSummary } from '@/lib/queries/vocabIntegration';
import { getDiagnosticBaselineState } from '@/lib/queries/diagnostics';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { GateRing } from '@/components/dashboard/GateRing';
import { GoalCards } from '@/components/dashboard/GoalCards';
import { AllocationCompare } from '@/components/dashboard/AllocationCompare';
import { GrammarVocabCard } from '@/components/dashboard/GrammarVocabCard';
import { QuantityZones } from '@/components/dashboard/QuantityZones';
import { ReviewDebtCard } from '@/components/dashboard/ReviewDebtCard';
import { SkillInvestment } from '@/components/dashboard/SkillInvestment';
import { StatusStrip } from '@/components/dashboard/StatusStrip';
import { TodayCard } from '@/components/dashboard/TodayCard';
import { TrendCard } from '@/components/dashboard/TrendCard';
import { WeaknessCard } from '@/components/dashboard/WeaknessCard';
import { WeekCard } from '@/components/dashboard/WeekCard';
import { VocabEngineCard } from '@/components/dashboard/VocabEngineCard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const nowDate = await businessToday();
  const [data, goals, vocab, diagnostic, timeZone] = await Promise.all([
    getDashboard(nowDate),
    getGoalCards(nowDate),
    getVocabDashboardSummary(),
    getDiagnosticBaselineState(),
    getBusinessTimezone(),
  ]);
  const gateResult: GateResult | null = data.gate?.gate ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">Dashboard 总览</h1>
          <p className="text-xs text-inkMuted">
            {nowDate} · 30 秒内回答「我在哪、今天做什么、哪里最弱、有没有欠账」
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href="/plan" className={buttonClass('primary', 'sm')}>
            开始今日计划
          </Link>
          <Link href="/records?new=1" className={buttonClass('secondary', 'sm')}>
            补录记录
          </Link>
          <Link href="/review" className="text-[11px] text-brand underline">
            复习中心
          </Link>
          <Link href="/weekly?tab=analytics" className="text-[11px] text-brand underline">
            分析看板
          </Link>
        </div>
      </div>

      {diagnostic.completedCount === 0 && (
        <Card
          title="尚未建立初始基线"
          dense
          actions={
            diagnostic.activeSessionId ? (
              <Link href={`/diagnostics/${diagnostic.activeSessionId}`} className={buttonClass('primary', 'sm')}>
                继续诊断
              </Link>
            ) : (
              <Link href="/diagnostics" className={buttonClass('primary', 'sm')}>
                开始诊断
              </Link>
            )
          }
        >
          <p className="text-xs text-inkMuted">
            先做一轮 AI 辅助的初始诊断（听力 / 阅读 / 口语 / 写作，分时段可暂停），再让计划草案使用真实证据。
            诊断结果不是官方 CEFR 认证；技术失败的任务不会被当作能力不足。
          </p>
        </Card>
      )}

      {diagnostic.completedCount > 0 && diagnostic.latestReportId && (
        <Card
          title="当前能力画像"
          dense
          actions={
            <Link href={`/diagnostics/report/${diagnostic.latestReportId}`} className={buttonClass('secondary', 'sm')}>
              查看诊断报告
            </Link>
          }
        >
          <p className="text-xs text-inkMuted">
            已有 {diagnostic.completedCount} 轮完成诊断；最新报告状态：
            {diagnostic.latestReportStatus === 'PROVISIONAL' ? '暂定（证据不足，需补测）' : '已出结果'}。
            四项技能分别呈现，不合成总体 CEFR。
          </p>
        </Card>
      )}

      {data.dataDays === 0 && (
        <EmptyState
          icon="flag"
          title="还没有任何学习证据"
          description="Dashboard 的时长、完成率、正确率、薄弱点全部由真实记录聚合而来，没有记录时不会显示任何假数据。先完成基线诊断并留下第一条记录。"
          dependencies={[
            '阶段已激活（阶段零只生成基线诊断任务）',
            '在 Planner 预览并确认当日任务，再开始计时',
            '记录页留下至少 1 条带产出的学习记录',
          ]}
          primary={{ label: '去 Planner 生成今日计划', href: '/planner/build?horizon=1' }}
          secondary={{ label: '手动补录一条记录', href: '/records?new=1' }}
        />
      )}

      {/* ⓿ 三目标卡（v2.0）：三条轨道并行展示，不做合计 */}
      <section aria-label="区块⓿三目标卡">
        <GoalCards goals={goals} />
      </section>

      {/* ① 状态条 */}
      <section aria-label="区块①状态条">
        <StatusStrip strip={data.statusStrip} />
      </section>

      {/* ② 四类量分区（计划时长 / 实际净时长 / 有效产出 / 知识掌握） */}
      <section aria-label="区块②四类量分区">
        <QuantityZones today={data.zones.today} week={data.zones.week} />
      </section>

      <div className="grid gap-3 xl:grid-cols-2">
        {/* ③ 今日 */}
        <section aria-label="区块③今日">
          <TodayCard data={data.today} />
        </section>

        {/* ④ 本周 */}
        <section aria-label="区块④本周">
          <WeekCard data={data.week} />
        </section>

        {/* ⑤ 四项投入 */}
        <section aria-label="区块⑤四项投入">
          <SkillInvestment data={data.skillInvestment} />
        </section>

        {/* ⑤b 四技能配比：实际 vs 建议（v2.0） */}
        <section aria-label="区块⑤b四技能配比">
          <AllocationCompare
            minutes={data.allocation.minutes}
            target={data.allocation.target ?? { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 }}
            profileCode={data.allocation.profileCode}
          />
        </section>

        {/* ⑥ 语法与词汇 */}
        <section aria-label="区块⑥语法与词汇">
          <GrammarVocabCard data={data.grammarVocab} />
        </section>

        {/* ⑥b 词汇引擎（v2.3）：只给可核对数字，七维在词汇页分开看 */}
        <section aria-label="区块⑥b词汇引擎">
          <VocabEngineCard data={vocab} timeZone={timeZone} />
        </section>

        {/* ⑦ 待复习 */}
        <section aria-label="区块⑦待复习">
          <ReviewDebtCard data={data.reviewDebt} />
        </section>

        {/* ⑩ 下一阶段验收完成度 */}
        <section aria-label="区块⑩阶段验收完成度">
          <GateRing data={data.gate} />
        </section>
      </div>

      {/* ⑧ 趋势 */}
      <section aria-label="区块⑧趋势">
        <TrendCard trend7={data.trend7} trend30={data.trend30} />
      </section>

      {/* ⑨ 薄弱点 Top3 */}
      <section aria-label="区块⑨薄弱点Top3">
        <WeaknessCard
          ranked={data.weakness.ranked}
          insufficient={data.weakness.insufficient}
          dataDays={data.weakness.dataDays}
        />
      </section>

      {/* 区块总览核对（便于验收） */}
      <Card title="数据口径自检" dense>
        <ul className="grid gap-1 text-[11px] text-inkMuted sm:grid-cols-2">
          <li>· 有效数据天数：{data.dataDays} 天（净时长 &gt; 0 的自然日）</li>
          <li>· 今日任务：{data.today.totalTasks} 条，已完成 {data.today.doneTasks} 条</li>
          <li>
            · EGIU 单元：{data.grammarVocab.colors.GREEN + data.grammarVocab.colors.YELLOW +
              data.grammarVocab.colors.RED + data.grammarVocab.colors.PENDING}{' '}
            个（按最新判定去重）
          </li>
          <li>
            · 复习待办：今日 {data.reviewDebt.dueToday} / 逾期 {data.reviewDebt.overdue} / 未来 7 天{' '}
            {data.reviewDebt.next7Days}
          </li>
          <li>· 薄弱点候选：{data.weakness.ranked.length} 项达到样本阈值</li>
          <li>
            · 升级建议：
            {gateResult ? (gateResult.suggested ? '全部硬条件满足' : `未满足 ${gateResult.unmet.length} 项`) : '无阶段'}
          </li>
        </ul>
      </Card>
    </div>
  );
}
