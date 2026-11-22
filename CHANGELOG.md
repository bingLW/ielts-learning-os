# Changelog

本项目采用手工维护的版本记录；每个条目只列已实际执行并验证的内容。

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