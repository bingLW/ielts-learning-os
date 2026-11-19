# IELTS Learning OS — 项目规则与长期记忆

> 本文件由 WorkBuddy 会话记忆迁移而来（导出快照 2026-11-17）。
> 精炼记忆全文见 `.workbuddy/memory/MEMORY.md`，逐日工作日志见 `.workbuddy/memory/2026-11-*.md`（追溯历史细节时按需读取）。
> 修改本项目前必须先读完下方「不可破坏的架构不变量」。

## IELTS Learning OS（单用户本地英语学习工作台）

- 位置：`~/ielts-learning-os`（原在 `~/WorkBuddy/软件开发/ielts-learning-os`，为绕开沙箱故障迁出）。
- 栈：Next.js 15 App Router + React 19 + TS strict + Tailwind v3 + Prisma 6 + SQLite（`prisma/dev.db`，**29 表**）+ Recharts v3 + zod v4 + Vitest 3。
- 文档：`docs/00-sop-source.md`（SOP 结构化基线）、`01-prd.md`（冻结）、`02-architecture.md`、`04-qa-report.md`（v1.5 + 附录 F 执行回填）、`05-handover.md`、`06-v2-upgrade-plan.md`（v2 差异分析 + 迁移方案 + P1–P5 执行回填）；`README.md`（含 §12 迁移与回滚）+ `scripts/verify.sh`（9 步）为交付入口。
- 测试：`src/lib/domain/__tests__/` **17 文件 / 407 用例**，只测纯函数。
- **交付状态**：v1.5（2026-11-09）全链路已验证；**v2.0 P0–P5 全部交付（2026-11-16）**——P1 21→29 表幂等回填；P2 计划按配比生成 + 记录表单轨道化 + 周复盘三轨道净时长卡；P3 `/mediated` 媒介学习闭环（单事务四落）；P4 `/general`、`/ielts` 页面 + SkillAssessment/IeltsAssessment 评估录入 + 三门禁独立呈现 + 导航 13 项；P5 AI 建议本地规则引擎（`domain/suggestion.ts` 三纯函数 + `queries/weakness.ts` 独立聚合，每条建议带非空 basis，不编造成绩）。`tsc` 0 错 / `typecheck:test` 0 错 / **407/407 全绿** / `next build` **21 路由** / 16 页面冒烟全 200。`npm run dev` 即用。

### v2.0 三轨道（P1 已落地的基础设施）

- 三轨道 `LearningTrack`：GENERAL_ENGLISH / IELTS_PREPARATION / ENGLISH_MEDIATED_LEARNING，**分别统计验收，绝不合并总分**。
- `PrimarySkill` 五值：L/R/S/W + **FOUNDATION**（词汇语法句子复盘泛练归集桶）。
- 配比分母**只含 L+R+S+W**；分母 0 → 占比 `null` → 展示 `—`。
- 阶段配比：A0–A2 30/30/25/15、A2–B1 28/27/25/20、B1–B2 25/25/25/25（`STAGE_ALLOCATION`）。
- 三 gate 独立：`evaluateGeneralEnglishGate`（只读 SkillAssessment）/ `evaluateIeltsGate`（只读 IeltsAssessment）/ `evaluateMediatedGate`（只读 EnglishMediatedSession）。**无换算表**。
- 关键模块：`src/lib/domain/allocation.ts`、`src/lib/domain/tracks.ts`、`src/lib/queries/goals.ts`。

### 不可破坏的架构不变量

1. 日/周净时长只能来自 `StudySessionDaySplit.minutes`，不得与 `StudySession.activeMinutes` 混算。
2. 计时器客户端只传 `expectedVersion`，服务端 `timerVersion` CAS；不用 localStorage。
3. 正确率唯一入口 `weightedAccuracy`（Σcorrect/Σtotal），`total=0` → `null` 展示为 `—`，**严禁**对 accuracy 数组取算术平均；`correct>total` 夹到 `total`。
4. 复习调度只有一张 `ReviewTask` 表（四种 targetType 共用）；`EgiuReview` append-only。
5. 阶段升级只给建议，手动切换必须写 `StageTransitionLog`。
6. 业务日期一律 `YYYY-MM-DD` 字符串，禁用 `toISOString().slice(0,10)`。
7. `rankWeaknesses` 三套口径不得互替：阈值用 `evidenceQuestions`（累加+`max(0,…)`）、打分用 `parts`（各项 max）、文案用最差来源同源分子分母。
8. 多来源挑最差样本分两种：错题率按 **rate** 挑；逾期条数/红灯单元数按 **分子** 挑（待办量，按 rate 会少报）。
9. **测试文件必须能被类型检查**：`tsconfig.json` 的 exclude 不含 `__tests__` 的类型检查，须跑 `npm run typecheck:test`（`tsconfig.test.json`）；D17 导入路径错误就是这么漏掉的。
10. **一条时长只落一条 `StudySession` + 一组 `DaySplit`**；轨道与技能是这条 session 的**属性**，不是第二份记录。`EnglishMediatedSession.durationMinutes` 只做表内自洽，**绝不参与任何求和**。
11. **浮点比较必须带容差**：`FLOAT_EPSILON=1e-9`。`0.7×4/4` 在 IEEE754 下是 0.6999999999999999，不加容差会把「恰好达标」判成不达标（D18）。
12. **聚合读 `session.skill` 快照，不读 `task.skill`**：`taskId` 可空后，媒介学习 session 无任务，join task 会漏算（D21）。
13. **四技能占比只走 `skillShare()`**：禁止用「多桶之和」当分母（D20 的成因）。

### 缺陷台账口径

编号到 D22，**缺陷共 21 个**（D1–D11、D14–D22）：20 项已修，D6（补录历史首测时复习点塌到同一天）保留为已知限制。D12/D13 是**口径条目**，非缺陷不计入。

v2.0 P1 新增 4 个：**D18** 浮点无容差（恰好达标判不达标）、**D20** SkillInvestment 用 8 桶之和当分母（违反分母隔离）、**D21** 聚合读 `task.skill` 导致无任务 session 漏算、**D22** schema 注释嵌套错误。

v1.5 的 D16–D19 为首次真实执行才暴露（1 个编译阻断 + 1 个导入路径 + 2 个测试样例自相矛盾）。

### 数据与环境注意

- 数据库 `prisma/dev.db` 是真实学习数据，**禁止** `prisma db push` / `db:reset` 等会动数据的命令；迁移环境只需 `npm i` → `npx prisma generate`。
- 完整迁移与回滚见 `README.md` §6 与 §12。
- 原 WorkBuddy 托管环境的沙箱经验（safe-delete-shim、Docker 逃生通道等）见 `.workbuddy/memory/MEMORY.md`「环境经验」节，仅在回到该环境时适用。