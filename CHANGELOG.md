# Changelog

本项目采用手工维护的版本记录；每个条目只列已实际执行并验证的内容。

## v2.7（进行中）— 规划内核

目标是让「为什么今天排了这些」可复现、可解释、可审计。数据层与两处「判定口径」修正已完成。

### 数据模型

- 新增 5 张规划域表（`PlanningSnapshot` / `SkillGap` / `TaskCandidate` / `TaskPriorityDecision` / `StageReadinessReview`），全库 110 → 115 表；迁移 `scripts/migrations/v2.7.mjs`（checksum `8563a351ba6ba475`），纯加法。
- 既有表新增 10 个可空列：`PlanTask.candidateId/decisionJson`、`PlanVersion.snapshotId/layer/parentVersionId/staleAt/staleReason`、`LearningCycle.primaryTheme/secondaryThemesJson/phaseChangedAt`。

### 判定口径修正

- **H4「投入稳定性」退出阶段晋级判定**（`stageGate`）。旧口径「净时长 ≥240 分钟/天」等于用固定时间投入模型否决不用户，30 分钟预算的用户永远不可能达标。现改为相对预算口径（净时长 ≥ 当日预算 × 60%，预算 <15 分钟的日期不进分母），且只作参考指标展示；旧口径数值保留为「旧规则参考值」并列显示，不静默删除痕迹。
- **预算解析收口为单一真值**（`domain/budget.resolveEffectiveBudget`）。原 `getEffectiveBudget` 与 `getBudgetRange` 是两份并行实现，在「没有 `PlannerSettings` 行」路径上分叉：逐日版给「建议 60 分钟/非休息日/`isSuggestion:true`」，批量版按星期模板给「周日 0 分钟/休息日/`isSuggestion:false`」。

### 行为变更（修正，非回归）

- `getBudgetRange()` 在「配置行不存在 + 周日」：由 `0 分钟 / 休息日 / 非建议` 变为 `60 分钟 / 非休息日 / 建议值`，与 `getEffectiveBudget()` 一致。
- `getBudgetRange()` 在「配置行不存在 + 工作日」：`isSuggestion` 由 `false` 变为 `true` —— 那个 60 分钟本来就是 `BUDGET_INITIAL_SUGGESTION`，不是用户设定的可用时间。
- 影响面：周视图 `budget.days[].isRestDay` / `isSuggestion`（页面已有「建议」标记，无需改文案）；H4 的分母（原先周日被静默跳过）；诊断报告里的星期模板解析（第三处自解析已并入 `parseWeekdayProfiles`）。

### 内部 DTO 扩展（非行为变更）

- `SkillGapDraft` 追加 `evidenceQuestions` / `repeatedErrorCount` 两个**派生字段**（与 `stale` 同样不落库）。此前二者缺失会让 T04 的 `errorRecurrence` 因子与 `noObservation` 标注整条失效，而只断言 `0.00` 的测试仍会全绿。`repeatedErrorCount` 的 `null`（未统计）必须原样保留，不得 `?? 0`。
- `candidateKey` 定为 `sourceKind:sourceRef|none:module`：**不含 `dateKey`**（一个快照一个 `asOfDate`，放进来会让跨快照比对永远失配），**也不含 `estMinutes`**（载荷不是身份）。
- `TaskCandidateDraft` 追加 **`dueDate: string | null`**（必填，不是可选）：`urgency` 因子与 `P0` 判定都需要"这条什么时候到期"，而它**只能由采集层填**（只有采集函数见过 `ReviewTask.dueDate` / `RetestSchedule.dueDate` / `EgiuLesson.nextReviewDate`），评分层自己查就变成第二套真相。**载荷不是身份**，不进 `candidateKey`。必填是刻意的：可选字段会让新采集函数"忘了填"而不报错，症状是"这条永远不紧急"，永远不会被发现。只有 3 个来源有到期概念，其余（`MATERIAL`/`QUESTION`/`LAB`/`VOCAB`）一律 `null` —— 给假到期日会让 `urgency` 把普通核心任务抬到 P1，而 P1 在装箱里属于核心保障，等于凭空多占预算。
- `repeatedErrorCount` 的取数口径（`planningSnapshot` 装配信号时）：`Mistake` 近 28 天、**能归属到 `StudyRecord`** 的错题条数，技能从 `studyRecord.skill` 取。窗口锚 **`StudyRecord.recordDate`（发生日期）而不是 `Mistake.createdAt`（录入时刻）** —— 后者会让"补录半年前的错题"抬高今天的重复度，又让历史 `asOfDate` 的快照看不到补录。

### 内部实现变更（行为不变）

- **`services/planningSnapshot.ts` 删掉了调用点的 `.filter(([, v]) => typeof v === 'number')`**（`parseSkillTargets` 的入参准备处）。守卫已移到 `parseSkillTargets()` 函数体内（`if (typeof value !== 'number') continue`），语义完全等价；删的理由是 `41 §1.9` **A-4**：一个 `export` 的函数如果去掉调用方的前置过滤就会错，那它自己就错了。留着那道 `.filter` 会让下一个调用点（T04 的 `goalRelevance`）以为"函数需要我这样做"，于是每个新调用点都加一份自己的守卫，而函数真正的边界永远没人管。
- 变更前后行为一致性有**可执行证明**：把 `parseSkillTargets` 的守卫退回 `Number(value)`（坏实现）——**不加** `.filter` 时夹具报 `{LISTENING: 0, READING: 7, …}`（红）；**加回** `.filter` 时全绿。同一个坏函数两种结果，正是"filter 的存在掩盖了函数本身的缺陷"的实证。夹具见 `services/__tests__/planningSnapshot.integration.test.ts`（`minReading: 7`、其余三项 `null`）。

### 测试

- 新增 `domain/__tests__/budgetResolve.test.ts`：五段分支各一条 + 「批量 vs 逐日」逐字段等价性（30 天 × 3 种配置状态）——后者是防止两条实现再次分叉的唯一防线。
- 新增 `src/lib/__tests__/helpers/testDb.ts`：集成测试建库助手，**强制调用方声明读集**（`delegates` 为空直接抛错、delegate 名写错直接抛错）。此前的做法是每个测试自己 `copyFileSync(dev.db)` + `deleteMany` 几张**它想得起来的**表，于是"读了但没清"的表把本机开发库的现状带进了断言。新建的两个集成测试已迁移；旧文件不动，碰到再迁。

## v2.6 — 2026-11-23

Smart Learning Materials：把用户授权材料导入为可追溯、可编辑、可训练的「智能学习材料」，接入词汇 / 阅读 / 练习 / 证据链路。

### 新增

- 材料导入：TXT/Markdown/HTML/文本型 PDF/DOCX + 粘贴摘录；内容嗅探、sha256 去重、七类来源与授权登记。
- 处理管线：校验→解析→规范化→AI 分析→生成练习，单机串行 tick + 3s 轮询，失败可重试。
- Reader：原文/词汇辅助双模式，原文区永不含 AI 文本；AI 分析审核（逐条+批量+溯源跳转）。
- 练习生成与作答：未审核题被 `materialExerciseGate` 结构性阻断出正式测评。
- 词汇候选审核 + 主库同步（已存在只加来源）；材料包 + 预算约束任务草案（确认前不写 PlanTask）。

### 数据模型

- 新增 17 张材料域表，全库 93 → 110 表；迁移 `scripts/migrations/v2.6.mjs`。

### 测试

- 83 文件 / 1156 例全绿；`typecheck` / `typecheck:test` 0 错误。

详细见 `docs/35-v2.6-changelog.md` 与 `docs/33–37`。

## v2.5 — 2026-11-22

Listening & Speaking Lab：听力与口语训练、诊断、证据采集与复测工作台。

### 新增

- `/listening` 听力实验室：音频上传（mp3/m4a/wav/webm/ogg/aac，≤50MB）、播放器（变速 0.75/1/1.25x、A-B 循环、Range 拖动）、转写对照、练习与作答。
- `/speaking` 口语实验室：麦克风录音（MediaRecorder）、回放、重录保留历史 take、九类口语题目、会话记录。
- 本地文件落盘：音频/录音写入 `storage/uploads`（gitignore），DB 只存相对路径 + sha256；`/api/audio/[id]` 流式读取支持 Range。
- ASR Provider Adapter 抽象：`src/lib/speech/provider.ts`；当前未接真实供应商，走手动转写降级（有意的安全默认）。
- 「退出系统」功能：`/settings` 底部新增二次确认关闭本机应用进程。

### 数据模型

- 新增 13 张表：AudioAsset、Transcript、TranscriptSegment、ListeningExercise、ListeningAttempt、ListeningError、SpeakingPrompt、SpeakingSession、SpeakingTurn、RecordingAsset、ASRResult、SpeechEvaluation、AudioTechnicalCheck。
- 首听结果与辅助后结果分字段保存，绝不覆盖；技术质量问题不计为英语能力错误。

### 数据库迁移

- 脚本：`scripts/migrations/v2.5.mjs`（纯加法、单事务、幂等、版本 + checksum 校验）。
- checksum：`6657ce882593958a`；真实库 `integrity_check=ok`、外键违规 0、核心表行数漂移 0。

### 验证

- `npm test`：52 文件 / 747 用例全部通过（净增 2 文件 23 用例）。
- `npm run typecheck`、`npm run typecheck:test`：通过。
- `npm run build`：通过（Docker node:22 容器）；`/listening`、`/speaking`、`/settings` 冒烟 200。

### 已知限制

- 未接入真实 ASR/TTS/发音分析 Provider（手动转写降级）。
- 口语 AI 反馈依赖 v2.4 外部 AI 通道。
- 听力九种训练模式交互表单与诊断集成（Phase F 运行时接线）为后续增量。

## v2.4.2 — 2026-11-22

Provider 凭据入库：API Key、Base URL、模型名改为前端页面配置。

### 新增

- `/ai-coach/admin` 新增「Provider 凭据」表单：API Key、Base URL、模型名；保存后立即生效。
- 新表 `AIProviderCredential`（单行）：API Key 以 AES-256-GCM 加密存储，仅保留末四位用于回显；页面与 Server Action 返回值不含明文或密文。
- 凭据解析优先级：管理页配置（数据库）> 环境变量 > 未配置（回落 Mock）；AI Coach 与诊断开放任务共用。
- 「清除 API Key」立即回落环境变量或 Mock，无需修改 `.env` 或重启。
- 加密密钥：`AI_CREDENTIALS_SECRET` 优先，否则自动生成 `.local/ai-credentials.key`（0600，已 gitignore）。

### 数据库迁移

- 脚本：`scripts/migrations/v2.4.2.mjs`（纯加法、单事务、幂等、版本 + checksum 校验）。
- checksum：`2c5b43e6736cbed7`；报告：`backups/migrations/v2.4.2-2026-11-22T08-43-53-390Z.json`。
- 真实库校验：`integrity_check=ok`、`foreign_key_check` 0 行、受保护表行数漂移 0。
- 回滚：`bash scripts/restore.sh backups/<升级前备份>` 后执行 `npm run db:generate`。

### 测试

- `npm test`：50 个文件 / 724 个用例全部通过（新增 `credentials.test.ts` 8 例、凭据集成用例 1 例）。
- `npm run test:e2e`：v2.1 + v2.2 + v2.3 + v2.4（含 v2.4.2 凭据）+ v2.4.1 全部通过。
- `npm run typecheck`、`npm run typecheck:test`、`npm run build`：通过。

### 已知限制

- 加密密钥不随数据库迁移：只复制 `dev.db` 到新机器时无法解密已存 Key，页面会提示重新填写。
- 管理页无账号鉴权（单用户本机应用）；部署到公网前必须加访问控制。

## v2.4.1 — 2026-11-22

AI 初始诊断与智能定级（AI Diagnostic & Intelligent Placement）。

### 新增

- `/diagnostics` 诊断入口、`/diagnostics/[id]` 会话页、`/diagnostics/report/[id]` 报告页；一级导航由 22 项增至 23 项。
- 11 张诊断域表：`LearnerProfile`、`DiagnosticBlueprint`、`DiagnosticItem`、`DiagnosticSession`、`DiagnosticAttempt`、`DiagnosticAsset`、`AssessmentResult`、`SkillProfileSnapshot`、`PlacementReport`、`PlanProposal`、`DiagnosticReviewRequest`。
- 21 道种子题库，覆盖 Listening / Reading / Speaking / Writing / Grammar / Vocabulary / Sentence Structure，以及可选 EMLR。
- 确定性判分、自适应难度路由、技能画像与报告草稿、7/30/90 天计划草案、报告复核与补测、诊断会话隐私删除。
- 诊断证据写入既有 `EvidenceRecord`（`evidenceType=BASELINE`），`DiagnosticAttempt.evidenceId` 一对一关联；不建第二套证据表。

### 评估约束

- 开放任务只接受外部 AI rubric 评估；未启用外部 AI 时保持 `NEEDS_REVIEW`，报告标记 `PROVISIONAL`，不使用 Mock 结果定级。
- 外发须用户同意：诊断开始页未勾选「外部 AI 同意」时，即使后台已启用外部 AI，本轮口语/写作也不会外发，保持 `NEEDS_REVIEW`（`src/lib/diagnostic/ai.ts`）。
- 技术无效的作答记录为 `INVALID`，不产生证据、不计分，并重新排队。
- 四项技能分别给出等级/范围/置信度，不平均成「总体 CEFR」；不是官方 CEFR 认证，也不预测 IELTS 分数。
- 计划确认只把 `PlanProposal` 标为 `ACTIVE`，不自动创建 `PlanTask`。

### 数据库迁移

- 脚本：`scripts/migrations/v2.4.1.mjs`（纯加法、单事务、幂等、版本 + checksum 校验）。
- 真实库校验结果：`integrity_check=ok`、`foreign_key_check` 0 行、核心表行数漂移 0；报告 `backups/migrations/v2.4.1-2026-11-22T07-54-52-281Z.json`。
- 回滚：`bash scripts/restore.sh backups/<升级前备份>` 后执行 `npm run db:generate`。

### 修复

- 诊断开放任务在用户未同意外部 AI 时仍可能调用外部模型；现改为在评估入口强制校验 `externalAiConsent`，未同意一律不外发（新增回归测试 `src/lib/diagnostic/__tests__/ai.test.ts`）。

### 验证

- `npm test`：49 个文件 / 715 个用例全部通过。
- `npm run test:e2e`：v2.1 + v2.2 + v2.3 + v2.4 + v2.4.1 全部通过。
- `npm run typecheck`、`npm run typecheck:test`、`npm run build`：通过。
- 浏览器冒烟：开始诊断、自适应升档、暂停/刷新/恢复、开放任务待评估、生成暂定报告、编辑并确认计划、补测、删除会话均实际执行。

### 已知限制

见 README §16.4（外部 AI 未启用时开放任务待评估、浏览器 TTS、录音上限、`AIEngineSetting` 历史 drift 等）。

## v2.4 — 2026-11-22

AI Learning Engine 与 Personal Tutor（`/ai-coach`）、9 张 AI 表、Prompt Registry、预算与隐私开关、Mock/外部 Provider 双通道。

## v2.3 — 2026-11-19

TypeWords 词汇引擎集成：词汇同步、动态词汇任务、多维掌握证据、词汇分析。

## v2.2 — 2026-11-19

证据驱动学习升级：Evidence Center、分项基线、障碍诊断、延迟复测、90 天周期、EMLR、方法论资料库。