# Changelog

本项目采用手工维护的版本记录；每个条目只列已实际执行并验证的内容。

## v2.7.1 — 2026-11-27

上线前缺口修复与发布收尾。**当前发布结论为 NOT READY FOR FIRST USE**：真实库事故未关闭，当前真实库副本的版本化迁移/回滚与真实 Provider smoke 未执行，浏览器并发、DEMOTE 与 CYCLE 分支未覆盖。

### 计划与预算

- 预算解析、最小任务粒度、逐日预算审计与统一写入者收口；诊断提案只有进入 Planner 预览并确认后才写正式任务。
- 日/周 GENERATE 接入 carryover：预览零写，确认在同一事务内应用滚存、校验预算、写任务与版本头；预算覆盖与库存指纹进入预览令牌。
- 旧固定生成、旧自适应生成与可导出的旧 `replanDailyTasksAction` 入口均拒绝写入，引导使用统一 Planner，避免绕过预算、库存和版本守卫。
- 计划时长与预算占用时长分开展示；实际净时长只取 `StudySessionDaySplit.minutes`。

### 估时与解释

- 生产候选估时接入近 90 天有效历史净分钟校准：至少 3 个样本时使用中位点估计与 P25–P75 区间，候选身份样本优先于技能样本；模型、规则、样本数和校准键写入决策快照。
- 用户指定分钟、诊断提案估时不被历史校准覆盖；新增异常或未完成样本不回写旧快照。默认估时仍不区分写作 Task 2/短句及口语题型，保持 PARTIAL。
- 计划解释优先回读持久化 `decisionJson`，不再重新评分；预计产出、目标参照和证据引用随确认计划保存，旧任务缺失时显示未知。

### 诊断、资产与隐私

- 补测保持 append-only；同基线报告取代与 finalize 在同一事务内完成；报告区分暂定、正式与证据不足。
- 听力与录音资产删除采用签名预览 + 事务复核 + tombstone，只允许删除无引用资产；保留子行、证据索引和物理文件，不做静默级联清除。
- Provider smoke 默认 `NOT_RUN`；真实调用必须同时显式 opt-in、使用 `/tmp` 隔离库和合成数据。不发送 API Key、用户录音或个人文档正文。

### 数据迁移与恢复

- 新增版本化 `scripts/migrations/v2.7.1.mjs`（checksum `7cd30baa4974708b6b1d2c3e4d279b45cff71eff1a30e78fceff06a4f58328bb`）：9 个追加列、2 个索引，迁移前自动备份，校验行数、结构、integrity 与外键，重复执行不重复变更。
- 新增空库安装守卫、数据库 + uploads 备份恢复与显式覆盖回滚演练；测试库统一从 schema 在系统临时目录创建，禁止复制或清理真实 `prisma/dev.db`。
- 隔离库迁移、幂等和恢复演练通过；真实 `prisma/dev.db` 曾被误执行 `prisma db push`，没有误操作前完整副本，不能声称逐字节恢复或 P0-5 通过。

### 文档与验证

- 新增修复报告、测试报告和发布清单：`docs/v2.7.1-fix-report.md`、`docs/v2.7.1-test-report.md`、`docs/v2.7.1-release-checklist.md`。
- 修正单数据点趋势提示；测试隔离、预计产出、历史估时校准、语音域关系动作和发布边界已同步到 README、使用指南与 Known Limits。

## v2.7 — 2026-11-27（实现完成；首次使用未放行）

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
- **Q6 唯一写入者**：材料草案确认、候选确认、手工加任务三个入口统一收敛到 `services/planWrite.ts` 的 `appendTaskFromCandidate()`，预算闸门整批只跑一次。材料确认过去走 `createPlanTaskAction` 只写 6 个字段，其余全落默认（`priority=P1`、`sourceKind=CORE`、`planVersion=1`、`splittable=false`）；现在写入 17 字段全量，`sourceKind` 经映射取 `MANUAL`、`planVersion` 由 `nextPlanVersion()` 派生并同事务写 `PlanVersion(MANUAL_ADJUST)`、`splittable` 由分钟派生。`confirmTaskProposalAction` 的签名、返回结构、组件 props 一律不变。重复确认同一个草案条目 → 幂等命中不写第二条（回填 `planTaskId` 在写入者事务内完成）。
  - 预算闸门守 v2.6「有超支一条都不写」语义：材料确认先调 `planWrite.validateBatchBudget()` 对**整批**条目一次性预检，通过后逐条写入传 `budgetPrevalidated:true` 跳过单条重复校验——入口与写入者共用同一个 `validateProposalAgainstBudget` 纯函数，口径不分叉，spy 断言整批确认只调用 1 次。单条入口（手工/候选）无批次预检，写入者内部照常跑唯一一次。
  - 回归：`services/__tests__/planWrite.integration.test.ts`（⑧–⑪）、`__tests__/regression/materialPack.q6.test.ts`（⑫–⑮，含「预算闸门只调一次」spy）、`__tests__/regression/noDoubleWrite.test.ts`（⑯⑰）。

### 内部 DTO 扩展（非行为变更）

- `SkillGapDraft` 追加 `evidenceQuestions` / `repeatedErrorCount` 两个**派生字段**（与 `stale` 同样不落库）。此前二者缺失会让 T04 的 `errorRecurrence` 因子与 `noObservation` 标注整条失效，而只断言 `0.00` 的测试仍会全绿。`repeatedErrorCount` 的 `null`（未统计）必须原样保留，不得 `?? 0`。
- `candidateKey` 定为 `sourceKind:sourceRef|none:module`：**不含 `dateKey`**（一个快照一个 `asOfDate`，放进来会让跨快照比对永远失配），**也不含 `estMinutes`**（载荷不是身份）。
- `TaskCandidateDraft` 追加 **`dueDate: string | null`**（必填，不是可选）：`urgency` 因子与 `P0` 判定都需要"这条什么时候到期"，而它**只能由采集层填**（只有采集函数见过 `ReviewTask.dueDate` / `RetestSchedule.dueDate` / `EgiuLesson.nextReviewDate`），评分层自己查就变成第二套真相。**载荷不是身份**，不进 `candidateKey`。必填是刻意的：可选字段会让新采集函数"忘了填"而不报错，症状是"这条永远不紧急"，永远不会被发现。只有 3 个来源有到期概念，其余（`MATERIAL`/`QUESTION`/`LAB`/`VOCAB`）一律 `null` —— 给假到期日会让 `urgency` 把普通核心任务抬到 P1，而 P1 在装箱里属于核心保障，等于凭空多占预算。
- `repeatedErrorCount` 的取数口径（`planningSnapshot` 装配信号时）：`Mistake` 近 28 天、**能归属到 `StudyRecord`** 的错题条数，技能从 `studyRecord.skill` 取。窗口锚 **`StudyRecord.recordDate`（发生日期）而不是 `Mistake.createdAt`（录入时刻）** —— 后者会让"补录半年前的错题"抬高今天的重复度，又让历史 `asOfDate` 的快照看不到补录。

### 内部实现变更（行为不变）

- **`services/planningSnapshot.ts` 删掉了调用点的 `.filter(([, v]) => typeof v === 'number')`**（`parseSkillTargets` 的入参准备处）。守卫已移到 `parseSkillTargets()` 函数体内（`if (typeof value !== 'number') continue`），语义完全等价；删的理由是 `41 §1.9` **A-4**：一个 `export` 的函数如果去掉调用方的前置过滤就会错，那它自己就错了。留着那道 `.filter` 会让下一个调用点（T04 的 `goalRelevance`）以为"函数需要我这样做"，于是每个新调用点都加一份自己的守卫，而函数真正的边界永远没人管。
- 变更前后行为一致性有**可执行证明**：把 `parseSkillTargets` 的守卫退回 `Number(value)`（坏实现）——**不加** `.filter` 时夹具报 `{LISTENING: 0, READING: 7, …}`（红）；**加回** `.filter` 时全绿。同一个坏函数两种结果，正是"filter 的存在掩盖了函数本身的缺陷"的实证。夹具见 `services/__tests__/planningSnapshot.integration.test.ts`（`minReading: 7`、其余三项 `null`）。

### 阶段就绪度（T09）

- 新增 `domain/readiness.ts` 的 `computeReadiness()`：五维（证据覆盖 / 多来源一致 / 无辅助完成 / 延迟保持 / 迁移证据）→ 5 结论。**晋级判定改由 `computeReadiness` 独家负责**；`stageGate` 只作「人工验收清单完成度」，两者互不引用结论（`importBoundary.test.ts` 断言互不 import）。结论映射顺序固定：`readErrors` → `NEED_MORE_EVIDENCE` → 任一维 `INSUFFICIENT` → `NEED_MORE_EVIDENCE` → `D4/D5 FAIL` → `NEED_TARGETED_PRACTICE` → 五维全 PASS → `READY_FOR_REVIEW` → 其余 `CONTINUE_CURRENT`。
- **F-2 类型级保障**：`ReadinessInput` 故意不含 `daysCompleted` / `completionRate` / `aiScore`，任何「靠时长或完成率晋级」的实现都拿不到输入；`@ts-expect-error` 三连 + `notConsidered`（学习天数 / 完成率 / 单次 AI 分数，只用于展示）作为反例区。
- 新增 `services/readiness.ts` 的 `persistReadinessReview()`：复用 `buildPlanningSnapshot({ purpose: 'READINESS' })` 装配缺口/不确定，聚合 `EvidenceRecord` / `RetestSchedule`，`criteriaJson` 必存五维明细（History 页可回溯「当时凭什么说 Ready」）。
- 新增 actions `reviewReadinessAction`（只建议，不切阶段）与 `confirmStageTransitionAction`（写 `StageReadinessReview.outcome=USER_APPROVED_TRANSITION` + `userConfirmed` + append-only `StageTransitionLog`）。`USER_APPROVED_TRANSITION` **不由 `computeReadiness` 返回**。

### 测试

- 新增 `domain/__tests__/budgetResolve.test.ts`：五段分支各一条 + 「批量 vs 逐日」逐字段等价性（30 天 × 3 种配置状态）——后者是防止两条实现再次分叉的唯一防线。
- 新增 `src/lib/__tests__/helpers/testDb.ts`：集成测试建库助手，**强制调用方声明读集**（`delegates` 为空直接抛错、delegate 名写错直接抛错）。此前的做法是每个测试自己 `copyFileSync(dev.db)` + `deleteMany` 几张**它想得起来的**表，于是"读了但没清"的表把本机开发库的现状带进了断言。新建的两个集成测试已迁移；旧文件不动，碰到再迁。

### 计划链路（T05 / T07 / T08）

- **T05 装箱引擎扩展：行为不变的兼容承诺。** `domain/adaptivePlan.ts` 只为 `generateAdaptivePlan` 增加可选输入（候选与 carryover 相关字段），**不传这些字段时输出与 v2.1 逐字相同**；由 `adaptivePlanGolden.test.ts` 的 18 组黄金对照锁定。这不是行为变更，而是「新链路可以加、旧调用点结果不会被动到」的证明。
- **T07 计划构建：预览零写、确认才落库。** 新增 `services/planBuild.ts` 的 `buildPlan()`：任何调用都只返回 `BuildPlanResult`（`preview: true` 恒成立），**从不写 `PlanTask` / `PlanVersion`**；确认时用 `previewTokenOf(snapshotId, inputHash, budgetOverrideMinutes)` 重算令牌，不一致返回 `CONFLICT`，通过后在**同一事务**写版本、任务、候选与决策。`budgetOverrideMinutes` 刻意进签名：它不在快照 `inputHash` 里，但会改变落库分钟，不入签就会出现「预览 60 分钟、确认写出 90 分钟」。
- **T07 评分与排序口径。** 七因子加权（`urgency 0.22` / `goalRelevance 0.18` / `evidenceStrength 0.20` / `errorRecurrence 0.12` / `prerequisiteReady 0.10` / `timeCost 0.10` / `preferenceFit 0.08`，合计 1.000），阈值 `P1 ≥ 0.60`、`P2 ≥ 0.42`；**到期复习/复测一律 P0，不看分数**；P0 之外先按优先级、再按分数降序、最后按 `candidateKey` 升序，保证同样输入得到同样排列。`weightsVersion` 当前 `w1`，改权重或阈值必须递增。
- **T08 重排与滚存。** `domain/replan.ts` 的 `replanDailyTasks()` 产出 `KEEP` / `SHRINK` / `DEFER` 三类处置（未开始任务才会被 `DEFER`），`services/replanPreview.ts` 提供 `previewReplan()`（零写）与 `confirmReplan()`（幂等键 + 事务）。`domain/carryover.ts` 的 `carryoverPolicy()` 产出 `PROMOTE` / `DEMOTE` / `BACKLOG` / `ABANDON` 四类裁决（单日条数/分钟上限、顺延次数上限）。v2.7 时 `services/carryoverApply.ts` 尚未接线；**v2.7.1 已接入日/周 GENERATE 的预览与单事务确认，并保护 replan 中的滚入任务**，详见 `docs/47` §6 与 `docs/51-v2.7.1-phase-c-test-report.md`。

### AI 建议层（T14）

- 新增 3 个规划类 prompt kind（`ai.plan.*` 命名空间，首次注册即 `v1`）：`plan_explain`（逐条理由，最多 60 条）、`plan_suggest_candidates`（从候选池挑最多 10 条，可为空）、`plan_weekly_theme`（恰好 3 个主题选项）。输出 schema 全部 `.strict()`，任何越界字段直接判 `INVALID_OUTPUT`。
- `aiMode` 三态：`off`（`allowAi` 非 true 或 Provider 不是外部模式 → **零调用**）、`on`（全部成功或仅单条被拒）、`failed`（任一调用失败/输出非法 → **丢弃全部 AI 效果**，计划仍 `ok:true`，`aiNote` 带错误码）。不存在「一半任务带 AI 标记、一半不带」的中间态。
- 拒绝分三类且都**不落半截数据**：池外 key → `REJECTED_NOT_IN_POOL`（不新建 `TaskCandidate`）；超预算 → `REJECTED_AI_OVER_BUDGET`（整条拒绝，**不按比例裁剪**）、改动决策字段 → `REJECTED_AI_MUTATED_DECISION`（`assertReasonOnlyChanged()` 逐字段深比较，只放行 `rationale`）。
- `byAi` 在 `assembleDraft` 中**只赋值一处**：`aiMode==='on' && isAiSuggested && eligibility==='ELIGIBLE' && ai.picks.has(key)` 四条件同时成立。由 `byAi.test.ts` ⑪ 的文本扫描锁定（赋值点数量、无二次赋值、四条件齐全）。
- 新增测试 13 条：`ac/aiFallback.test.ts`（4）、`ac/aiRejection.test.ts`（6）、`byAi.test.ts`（3），全部用 `vi.spyOn(OpenAICompatibleProvider.prototype, 'complete')` 注入假响应，不发外部请求。

### 文档与版本收尾（T14b）

- 新增 `docs/43-v2.7-api-contracts.md`、`docs/45-v2.7-test-report.md`、`docs/46-v2.7-user-guide.md`、`docs/49-v2.7-prompt-changelog.md`；补充 `docs/44-v2.7-scheduler-spec.md`（§4.1 可复算依据）与 `docs/47-v2.7-known-limits.md`（§9 数据/查询遗留、§10 AI 边界）。`docs/48-v2.7-migration-guide.md` 已含备份/校验/回滚，未改。
- `.env.example` 核对结果：**v2.7 规划域不引入任何新环境变量**，AI 相关沿用 v2.4 的 `AI_PROVIDER_API_KEY` / `AI_PROVIDER_BASE_URL` / `AI_PROVIDER_MODEL`（均已标注可选），并注明 v2.7 默认 `allowAi` 关闭。
- README 更新：页面地图 23 → 27 个入口（新增 `PLANNER` 组 4 个入口）、数据库表数 80 → 115、测试数改为 133 文件 / 1571 用例，文末新增 §19 v2.7 升级指引。

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