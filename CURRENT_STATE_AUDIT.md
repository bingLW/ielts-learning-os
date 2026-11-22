# CURRENT_STATE_AUDIT — v2.4.1 开发前盘点（2026-11-22）

本文件为 v2.4.1 AI Diagnostic & Intelligent Placement 的 Phase 0 交付。所有结论均来自当前仓库代码、Prisma Schema、实际运行测试与本地数据库，不是推测。

## 1. 技术栈与部署方式

| 项目 | 现状 |
| --- | --- |
| 框架 | Next.js 15.5.29 App Router + React 19，Server Component + Server Action，无独立 REST 层 |
| 语言 | TypeScript 5 strict，路径别名 `@/*` → `src/*` |
| 数据库 | SQLite 单文件 `prisma/dev.db`，Prisma 6.16.2 |
| 样式 | Tailwind CSS v3，三色状态变量；桌面侧栏 + 移动端底部导航 |
| 校验 | zod v4，Server Action 入口校验 |
| 测试 | Vitest 3：46 文件 / 692 用例；tsx E2E 脚本 v2.1–v2.3；v2.4 集成测试使用数据库副本 |
| 部署 | 单用户、本地优先；`npm run dev` / `npm run build` + `npm start`；无账号体系、无队列、无对象存储 |
| 备份 | `scripts/backup.sh` / `scripts/restore.sh`（sqlite3 `.backup` / `VACUUM INTO`），备份目录 `backups/` |
| 迁移 | 版本化脚本 `scripts/migrations/v2.2.mjs`、`v2.3.mjs`、`v2.4.mjs`；`AppMigration(version, checksum)`；迁移前备份、迁移后完整性/行数校验 |
| 当前库 | 68 张业务表，已登记 `v2.2` / `v2.3` / `v2.4` |

## 2. 现有 AI Engine 能力（v2.4，可复用）

| 能力 | 位置 | 可复用方式 |
| --- | --- | --- |
| Provider Adapter | `src/lib/ai/provider.ts` + `config.ts` | 直接复用；Mock 默认、OpenAI 兼容可选 |
| Prompt Registry | `src/lib/ai/prompts.ts` + `registry.ts` | 追加新 prompt kind，版本只增不改、sha256 校验 |
| 结构化输出校验 | `src/lib/ai/structured.ts` | 新增诊断专用 zod Schema |
| Token/成本计量与预算 | `src/lib/ai/meter.ts` | 复用预算窗口与成本估算 |
| 调用日志 | `AICallLog`（`sessionId` 可空） | 诊断调用以 `sessionId=null` 记录，元数据带诊断会话 ID |
| 隐私脱敏 | `src/lib/ai/privacy.ts` | 复用邮箱/Token/长数字/路径脱敏与长度截断 |
| 失败重试 | `src/lib/ai/orchestrator.ts` | 复用 TIMEOUT / NETWORK 最多重试 1 次的策略 |
| 免责声明 | `AI_ASSESSMENT_DISCLAIMER_ZH` | 报告与开放题评估统一展示 |

**缺口**：现有 `runAiTurn` 强绑定 `AILearningSession` 与教学轮次，不能直接用于诊断评分、画像摘要与计划草案。v2.4.1 需要新增通用结构化调用入口，但复用 Provider / Registry / Schema / Meter / 日志。

## 3. 现有数据库实体及关系（与诊断相关）

| 实体 | 用途 | 与 v2.4.1 的关系 |
| --- | --- | --- |
| `UserProfile` | 单用户目标、时区、旧预算字段 | 新增 `LearnerProfile` 承载诊断背景，避免把自述写成能力 |
| `SkillProfile` | 四技能方向 + 置信度 + 证据依据 | 诊断快照不直接覆盖；报告另存 `SkillProfileSnapshot` |
| `EvidenceRecord` | 六类证据、A0–A4、自评/AI/考试评估者 | 诊断作答可写入 BASELINE 证据，`score` 仅 0–2 |
| `SkillAssessment` / `IeltsAssessment` | 用户手工 CEFR / 雅思记录 | 诊断结果不写入这两张表，避免冒充正式测评 |
| `PlanTask` / `DailyBudget` / `WeeklyTarget` / `WeeklyDayAllocation` / `PlannerSettings` / `PlanVersion` | v2.1 动态时间预算与计划 | 计划草案读取预算，不直接写入正式计划 |
| `VocabularyItem` 等 14 张词汇表 + `IntegrationJob` | v2.3 TypeWords 词汇域 | 词汇诊断可引用词库，但不修改掌握状态 |
| `Mistake` / `ReviewTask` / `RetestSchedule` | 错题、复习、复测 | 低置信度补测可复用 `RetestSchedule` 概念，但诊断补测独立排队 |
| `AppMigration` | 迁移版本登记 | v2.4.1 追加 `v2.4.1` 记录 |
| `AICallLog` / `PromptVersion` | 调用与提示词追溯 | 诊断评估必须写日志并引用 prompt 版本 |

## 4. Learning Evidence 实际结构

`EvidenceRecord` 关键字段：`skill`、`evidenceType`、`level`、`parentEvidenceId/chainRootId`、`conditionJson`、`outputText`、`score(0–2)`、`scoreReason`、`dimensionsJson`、`evidenceAnchor`、`assistanceLevel(A0–A4)`、`assessorType(SELF/TEACHER/PEER/AI/EXAM)`、`confidence(LOW/MEDIUM/HIGH)`、`privacyLevel`。

现有 E2E 已锁定：AI 即时复测写入 A0 + AI 评估 + 免责声明；删除 AI 会话保留证据。v2.4.1 沿用同一证据模型，不建第二套。

## 5. 现有学习计划 / 动态预算接口

- `getEffectiveBudget` / `DailyBudget` / `WeeklyTarget` / `WeeklyDayAllocation`：按日期返回有效分钟预算。
- `PlannerSettings`：工作日/周末差异、休息日、单日上下限。
- `PlanTask`：正式任务；v2.4.1 **不自动写入**，计划草案只读预算并在用户确认后标记 ACTIVE。
- 现有 AI Coach 已能读取 profile / stage / recent evidence 构建最小上下文，可复用为诊断摘要的输入边界。

## 6. 现有词汇 / TypeWords 接口

- 导入：`/vocabulary/sync` 接受 TypeWords ZIP/JSON，写 `IntegrationJob` 与词汇会话。
- 主数据：`VocabularyItem` / `VocabularyItemSource` / `VocabularyDeck` / `VocabularyKnowledgeState`。
- 导出：`/vocabulary/today` 生成兼容包。
- 诊断词汇题优先使用自有 `DiagnosticItem` 题库，不修改 `VocabularyKnowledgeState`；可记录来源引用。

## 7. 可复用页面与组件

| 复用对象 | 用途 |
| --- | --- |
| `components/ui/Card` / `Button` / `FormField` / `Toast` | 诊断页面与现有页面视觉一致 |
| `AiSessionWorkspace` 的交互模式 | 分步任务、暂停/继续、错误提示、二次确认删除 |
| `EvidencePageBody` 的证据展示 | 报告中的原始样本入口 |
| `Sidebar` + `NAV_ITEMS` | 新增一级入口 `/diagnostics` |
| Dashboard 区块结构 | 增加「尚未建立初始基线」提示卡 |
| `scripts/e2e-v2x.mts` 的数据库副本模式 | v2.4.1 E2E 安全边界 |

## 8. 数据风险与迁移风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 原始作答被覆盖 | 诊断要求原始表现不可改 | `DiagnosticAttempt.responseText` 只写一次；重测新建 attempt；AI 评分存 `AssessmentResult` |
| 音频体积 | SQLite 存 base64 音频会膨胀 | 限制单条 ≤ 1.5MB / 90 秒；超限不保存并标记技术状态；报告可删除 |
| 技术故障被当成低分 | 音频无声、ASR 失败会污染画像 | `INVALID` 状态不计分、不写证据；报告中单列无效项 |
| 自述等级冒充结果 | 背景表单可能含主观等级 | `LearnerProfile` 只存目标与背景；等级只来自 attempt 聚合 |
| 一次测验定级 | 单题波动大 | 每技能至少 2 个样本；置信度 LOW 时输出范围与补测建议 |
| AI 幻觉答案 | 开放题评分不可验证 | 客观题答案来自题库；开放题必须引用原文片段并受 rubric 版本约束 |
| 低置信度强行定级 | 报告误导 | `confidence=LOW` 时 `estimatedLevel` 输出范围，界面显示「暂不能判断 / 待补测」 |
| 迁移失败 | 11 张新表 + 回填 | 单事务、幂等、迁移前备份、迁移后 integrity/foreign_key/行数校验；回滚依赖备份 |
| 报告覆盖 | 新报告可能改写旧结论 | `PlacementReport` 追加式，旧报告 `SUPERSEDED` 并保留 |
| 计划自动启动 | 违反用户确认原则 | PlanProposal 默认 DRAFT，必须显式激活 |

## 9. v2.4.1 差距清单

| 编号 | 缺口 | 计划 |
| --- | --- | --- |
| G1 | 无诊断蓝图/题库 | 新增蓝图与题目模型 + 幂等题库初始化（客观题 + rubric 开放题） |
| G2 | 无诊断会话/尝试/资产 | 新增 Session / Attempt / Asset，支持暂停恢复、无效标记 |
| G3 | 无诊断评分与置信度 | 确定性客观评分 + AI 开放题评分 + 纯函数聚合 |
| G4 | 无四项画像快照与报告 | 新增 SkillProfileSnapshot / PlacementReport / ReviewRequest |
| G5 | 无计划草案 | 新增 PlanProposal，读取 v2.1 预算，用户确认后 ACTIVE |
| G6 | 无诊断入口与页面 | `/diagnostics`、`/diagnostics/[id]`、`/diagnostics/report/[id]`、Dashboard 提示 |
| G7 | 无诊断专用 Prompt | 追加 Speaking/ Writing Evaluator、Placement Summarizer、Plan Generator |
| G8 | 无诊断测试 | 纯函数单测 + 数据库副本集成 + E2E v2.4.1 + 失败路径 |
| G9 | 无诊断迁移与文档 | `v2.4.1.mjs`、CHANGELOG、用户手册、接口文档、回滚说明 |

## 10. 结论

v2.4 AI Engine 的 Provider、Prompt Registry、Schema、预算、日志与脱敏可直接复用；v2.2 证据模型与 v2.1 预算模型可承接诊断结果与计划草案。v2.4.1 采用**纯加法**：新增 11 张诊断域表、1 个一级入口、1 个迁移脚本，不修改既有业务表语义，不写入正式计划，不覆盖历史报告。详细设计与接口见 `docs/24-v2.4.1-design.md`。