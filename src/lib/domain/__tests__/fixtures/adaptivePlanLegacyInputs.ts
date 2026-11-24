/**
 * v2.1 golden 的 18 组输入（`41 §3.3`）。
 *
 * 这些输入**只为固化 v2.1 行为**而存在，不追求覆盖面（覆盖面在 `adaptivePlan.test.ts`）。
 * 它们的作用是：一旦有人改动 `generateAdaptivePlan` 的算法，`adaptivePlanGolden.test.ts`
 * 会以"逐字不同"的形式立刻失败，迫使改动者在 PR 里显式说明"这是行为变更"。
 *
 * 18 组的构成（与 `41 §3.3` 一一对应）：
 * - 预算 `0/15/30/45/60/90/120/180/240/300/600`（11 组）
 * - `isRestDay=true` / `tierCode` 缺失 / `S0_PREP` / `S1` 语法 20% 封顶 /
 *   短时预算单技能 / 有 `weakSkills` / 有 `weeklyGap` / 有 `dueRetests` 放不下 → 顺延（7 组）
 *
 * 输入里**不出现** v2.7 的四个新字段：这是 v2.1 基准。新字段的等价性由
 * `adaptivePlanGolden.test.ts` 的断言 2/3/4 单独验证。
 */

import type { AdaptivePlanInput } from '../../adaptivePlan';

/** 通用英语 A0–A2 阶段配比（贴近真实建档，四项合计 100）。 */
export const A0_ALLOCATION = { LISTENING: 30, READING: 30, SPEAKING: 25, WRITING: 15 };

/** 一条固定 id 的审计分组：输入里的 id/label 会进 `rationale`，所以必须固定。 */
const REVIEW_12 = { estMinutes: 12, count: 3, maxOverdueDays: 0 };
const REVIEW_25_OVERDUE = { estMinutes: 25, count: 4, maxOverdueDays: 2 };

export interface LegacyGoldenCase {
  /** 用例名（只用于失败信息，不进 golden 内容）。 */
  name: string;
  input: AdaptivePlanInput;
}

export const LEGACY_GOLDEN_CASES: LegacyGoldenCase[] = [
  // ── 11 组：预算 sweep（0 = 休息日） ──
  {
    name: 'budget-0-休息日',
    input: { budgetMinutes: 0, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-15-应急',
    input: { budgetMinutes: 15, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-30-最低',
    input: { budgetMinutes: 30, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-45-轻量',
    input: { budgetMinutes: 45, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-60-标准',
    input: { budgetMinutes: 60, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-90-标准+',
    input: { budgetMinutes: 90, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-120-集中',
    input: { budgetMinutes: 120, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-180-深度',
    input: { budgetMinutes: 180, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-240-扩展',
    input: { budgetMinutes: 240, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-300-超长',
    input: { budgetMinutes: 300, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'budget-600-极端',
    input: { budgetMinutes: 600, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },

  // ── 7 组：形态与边界 ──
  {
    name: 'isRestDay-休息日但预算非零',
    input: { budgetMinutes: 60, isRestDay: true, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'tierCode-缺失',
    input: { budgetMinutes: 75, stageCode: 'S1_A0_A2', allocation: A0_ALLOCATION },
  },
  {
    name: 'S0_PREP-只排基线诊断',
    input: { budgetMinutes: 60, stageCode: 'S0_PREP', allocation: A0_ALLOCATION },
  },
  {
    name: 'S1-语法封顶 20%',
    input: {
      budgetMinutes: 120,
      stageCode: 'S1_A0_A2',
      allocation: { LISTENING: 20, READING: 20, SPEAKING: 20, WRITING: 40 },
      dueReviews: REVIEW_12,
    },
  },
  {
    name: '短时预算-单技能（15 分钟 + 到期复习）',
    input: { budgetMinutes: 15, stageCode: 'S2_A2_B1', allocation: A0_ALLOCATION, dueReviews: REVIEW_12 },
  },
  {
    name: 'weakSkills + weeklyGap',
    input: {
      budgetMinutes: 90,
      stageCode: 'S2_A2_B1',
      allocation: A0_ALLOCATION,
      weakSkills: ['READING', 'LISTENING'],
      weeklyGap: { READING: 40, LISTENING: 20 },
      dueReviews: REVIEW_25_OVERDUE,
    },
  },
  {
    name: 'dueRetests-放不下则整项顺延',
    input: {
      budgetMinutes: 30,
      stageCode: 'S3_B1_IELTS',
      allocation: A0_ALLOCATION,
      dueReviews: REVIEW_12,
      dueRetests: { items: [{ id: 'retest-a', minutes: 25 }], maxOverdueDays: 1 },
    },
  },
];
