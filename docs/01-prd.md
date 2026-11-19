# IELTS Learning OS 产品需求文档（PRD）

> 版本 v1.0 ｜ 产品经理：许清楚 ｜ 业务规则唯一依据：`docs/00-sop-source.md`
> 本 PRD 中所有阈值与 SOP 一致，不新增、不改动、不删减 SOP 的判定标准。

## 0. 项目信息

| 项 | 内容 |
|---|---|
| Language | 简体中文（术语保留英文：EGIU、S/V/O/C、Band、CEFR、LLD、Oxford 3000） |
| Project Name | `ielts-learning-os` |
| 技术栈 | Vite + React + MUI + Tailwind CSS（架构师可按需调整，PRD 不绑定） |
| 产品形态 | 单用户 Web 工作台，桌面优先（≥1280 基准），兼容平板/手机 |
| 时区 | Asia/Singapore（UTC+8），全局唯一时区，所有「自然日」均按此切分 |
| 原始需求复述 | 为一个「英语零基础、EGIU 已学过一遍但间隔较久、每日可投入 4–5 小时、目标 B2 + 雅思 6.0–6.5」的个人，提供覆盖「计划→执行→记录→评估→错题复习→分析→验收→下一阶段」全闭环的学习管理工作台。它不是打卡工具，核心资产是**可检查的学习证据**。 |

**非目标（明确不做）**：多租户/班级/教师端、社交与排行榜、完整 Anki 记忆算法、第一期真实调用付费 AI、自动代做题目或自动判分雅思作文。

## 1. 产品目标与成功标准

| 编号 | 目标 | 可度量成功标准 |
|---|---|---|
| G1 | 让「今天学什么」不再需要决策 | 用户打开 Dashboard → 开始第一个任务 ≤ 2 次点击；每日计划由系统在阶段规则下自动生成，用户仅做调整 |
| G2 | 每条学习行为都留下可检查的证据 | 任一 `study_record` 必须挂载 ≥1 项产出（正确率/摘要/录音链接/短文/错题）；产出缺失率 < 10% |
| G3 | 用数据而非日历决定是否升级 | 阶段升级 100% 经 `stage_acceptance_item` 判定，系统不提供「按天数自动升级」开关；每次升级有 `stage_transition_log` 记录 |
| G4 | 错题与复习形成闭环 | 红灯/黄灯单元 100% 生成复习任务；逾期复习任务在 Dashboard 可见且不会被静默丢弃 |
| G5 | 指标口径可解释 | 每个图表可下钻到构成它的原始记录；不存在任何硬编码或 mock 数据 |

**北极星指标**：`周有效学习证据数` = 当周满足「有计划时长 + 实际时长 + 可检查产出 + 正确率或文本产出」四项俱全的 `study_record` 条数。
**护栏指标**：`计划完成率` 与 `净学习时长` 必须成对展示，禁止单独用任意一个代表学习效果。

## 2. 用户画像与核心场景

**唯一用户画像**：单人自学者。英语零基础；EGIU 初级已完整学过一遍并做完练习，但间隔较久、掌握度不确定（→ 必须走**诊断式复习**，不从零重学）；每日净学习 4–5 小时；长期目标 B2 并完成雅思；雅思目标分可配置，初始 6.0–6.5。使用场景为桌面/笔记本，晚间为主，偶发手机碎片化补录。

| 场景 | 链路（真实使用路径） |
|---|---|
| **S1 学完一个 EGIU 单元（核心闭环）** | 计划页点开「语法/句型 40min」→ 计时开始 → 记录页新建记录（Lesson 3-3、题数 8、正确 6、能否解释规则=否、新造句 1 个）→ 系统判 YELLOW → 自动生成 D1/D3/D7 复习任务 + 错题 2 条入错题库 → 回 Dashboard 看到 EGIU 黄灯 +1、待复习 +3 |
| **S2 早晨开机 30 秒决定今天** | 打开 Dashboard → 看到「今日计划 240min / 9 模块 / 待复习 5 条 / 薄弱点 Top3：一般现在时三单、弱读连读、段落主题句」→ 点「开始今日计划」→ 任务列表已按 SOP 主线顺序排好 |
| **S3 中途被打断** | 听力任务「进行中」→ 关闭浏览器 → 30 分钟后回来，Dashboard 提示「听力任务未结束，是否继续计时/标记部分完成」→ 选择部分完成（实际 22min/45min）→ 系统按 22/45 计权，任务状态=部分完成 |
| **S4 D3 复测失败** | 复习队列 → 重做该单元 8 题，正确 5（62.5%）→ 仍判 RED → 系统追加 D7、D14、D21 复习点，红灯计数+1，薄弱点排序中该知识点上移 |
| **S5 周日复盘与下周定位** | 复盘页 13 项指标自动填充 → 词汇抽测正确率 72%（<80%）→ 系统给出建议：下周新词量从 18 降至 12、旧词复习占比提高 → 用户确认 Top3 薄弱点 → 导出周报 → 下周计划按薄弱点加权生成增量时长 |
| **S6 阶段一结束时验收** | 阶段页展示 7 维度验收清单 → 用户逐项填入实际测试结果（录音时长、写作词数、听力材料份数）→ 系统显示「4/5 必验项通过，未通过：口语 2–3 分钟持续表达」→ 不给出升级建议 → 补练 2 周后全部通过 → 输出「建议升级」+ 证据快照 → 用户手动确认 |

## 3. 信息架构与导航

一级导航固定 11 项（左侧栏，桌面常驻；移动端底部 5 项 + 抽屉），与业务方原始需求列出的 11 个「主要页面」一一对应：

| # | 一级页面 | 二级页面 / Tab |
|---|---|---|
| 1 | **Dashboard 总览** | —（单页，含薄弱点抽屉、待复习抽屉） |
| 2 | **学习计划（每日计划）** | 日历视图 / 列表视图 / 模板与调整 / 当日总结 |
| 3 | **学习记录** | 全部记录 / 按科目（听力·阅读·口语·写作）/ 记录详情·编辑 |
| 4 | **语法诊断（EGIU）** | 单元清单（三色看板）/ 单元详情 / 复测历史与掌握度曲线 |
| 5 | **错题与复习（错题本）** | 错题库 / 复习队列（今日·逾期·未来）/ 复习任务详情 |
| 6 | **词汇（词汇管理）** | 词表 / 今日新词与复习 / 随机抽测 / 词汇统计 |
| 7 | **句子成分（句子分析）** | 句子列表 / 句子详情（S/V/O/C/A 标注）/ 句型扩展（五大句型·从句·非谓语） |
| 8 | **资源库（学习资源）** | 资源清单 / 资源详情与进度 / 新增·编辑 |
| 9 | **每周复盘** | 本周复盘 / 历史周报 / 下周薄弱点 / **数据分析**（`/weekly?tab=analytics`） |
| 10 | **阶段与验收（学习阶段）** | 阶段时间线 / 验收清单 / 升级建议与历史 |
| 11 | **系统设置** | 学习目标 / 时间与时长 / 数据导出与备份 / AI 配置（预留）/ 关于与免责声明 |

> 侧栏分组（每日执行 / 诊断与复习 / 复盘与配置）属呈现层细节，规范性依据仅为本节列出的线性顺序；调整分组不作为需求变更。

**导航决策**：业务方原始需求中「数据分析与可视化」（10 张图表）是**能力要求**而非独立页面，故不单列一级导航，改为「每周复盘 › 数据分析」Tab（`/weekly?tab=analytics`），并可从 Dashboard 图表区块与周报页直接进入。这样一级导航稳定在 11 项、不膨胀到 12 项，同时图表与周报在语义上本就同属「复盘」环节。**资源库**为一级页面（用户原文列出的「学习资源」）；同时在 Dashboard、记录表单、计划生成规则中以资源选择器形式出现（数据驱动，不写死）。

## 4. 需求池

### P0（Must have — 缺失则闭环断裂）

| 编号 | 需求 | 验收口径 |
|---|---|---|
| P0-01 | 四阶段模型（S0 准备 1–2 天 / S1 A0→A2 4–6 月 / S2 A2→B1 3–4 月 / S3 B1→IELTS 3–5 月+），含开始日期、预计结束、实际状态 | 4 个阶段均可创建并显示「已进行 N 天 / 预计 N 天」，超出预计时区显示「已超预估区间」但不判定失败 |
| P0-02 | 每阶段独立 7 维度验收清单（听力/阅读/口语/写作/语法/词汇/句子结构），可填实际测试结果与日期 | 每项含「标准描述（引用 SOP 原文）+ 我的实际结果 + 判定 passed/failed/pending + 证据链接」四字段，缺任一字段不可判 passed |
| P0-03 | 阶段「建议升级」判定器：满足硬条件才出建议，禁止按天数自动升级，手动调整须记录时间与原因 | 不满足硬条件时按钮为禁用态并列出未满足项；手动强制升级必须填写原因，写入 `stage_transition_log` |
| P0-04 | 每日计划自动生成：默认 240min / 9 模块（25/40/45/40/30/20/15/10/15），可扩至 270–300 | 生成结果模块数与分钟数与 SOP §2 表完全一致；总时长可调，调后各模块按 §6.2 规则重算 |
| P0-05 | 任务可增删改、拖拽调序、改时长；状态 5 态（待开始/进行中/已完成/部分完成/未完成） | 每次状态变更留 `status_changed_at`；非法流转（如 已完成→待开始）被拦截 |
| P0-06 | 任务计时：实际起止时间、实际时长、暂停、中断恢复、顺延到其他日期 | 中断恢复后实际时长 = 各段计时求和；顺延后原日期标记 moved_out、目标日 moved_in |
| P0-07 | 学习过程记录：通用 17 字段 + 4 科扩展字段（听力 6 / 阅读 6 / 口语 8 / 写作 7） | 4 科各建 1 条记录，扩展字段按科目条件渲染并落库；编辑保留 created_at/updated_at |
| P0-08 | EGIU 单元独立记录与三色判定（严格按 §6.1 算法） | 给定 (total, correct, explainOK, sentences, coreRuleOK) 任意组合，判定结果与 §6.1 伪代码逐条一致；含 <5 题的降权分支 |
| P0-09 | 复习调度引擎：D1/D3/D7/D14 生成、复测独立存档不覆盖、逾期保留、已掌握停止 | 红灯单元生成 4 个复习点，黄灯 3 个；复测后按 §6.3 追加；历史判定全部可查 |
| P0-10 | 错题库：7 类错误分类、关联知识点、复习次数、最近/下次复习、已掌握标记 | 每条错题可从记录或 EGIU 单元一键生成；复测通过后 `is_mastered` 可置真并停止排程 |
| P0-11 | 词汇管理：Oxford 3000、每日 15–20 新词、三档掌握度（认识但不能用/能理解/能主动使用）、随机抽测 | 新词与复习词分列生成；抽测 50–100 词输出加权正确率；掌握度三档可筛选统计 |
| P0-12 | 句子成分分析：S/V/O/C/Adverbial，词性与句子成分分列，记录是否正确与错误原因 | 词性下拉与成分下拉为两个独立字段，不可互相取值；支持按阶段筛选重点内容 |
| P0-13 | Dashboard 全部区块（阶段、累计天数/净时长、本周时长、今日/本周完成率、四项投入、语法词汇、待复习数、三色分布、7/30 天趋势、Top3 薄弱点、下一阶段验收完成度） | 区块数 = 12，且每块数据可由明细下钻验证；四类量（计划时长/实际时长/有效产出/知识掌握）在 UI 上分区不得混排 |
| P0-14 | 数据分析 10 张图 + 筛选（日期/阶段/科目/教材），全部由数据库真实数据计算；以「每周复盘 › 数据分析」Tab（`?tab=analytics`）承载 | 空库时图表显示空状态而非 0 值折线；筛选变更后所有图同步刷新；从 Dashboard 与周报页均可一键进入该 Tab |
| P0-15 | 每周复盘 13 项指标 + 确定下周 Top3 薄弱点 + 导出周报；系统设置（目标分/每日时长/时区/CSV·JSON 导出/备份）；资源库一级页面（8 类初始资源，数据驱动） | 13 项全部自动填充可手工覆盖；导出文件含 schema 版本号与导出时间；资源库新增资源不重启即生效且代码无枚举硬编码 |

### P1（Should have）

| 编号 | 需求 | 验收口径 |
|---|---|---|
| P1-01 | 资源库进阶能力：批量导入导出、资源使用时长是否满 4 周的提醒、关联记录数与 EGIU 单元数的联动统计（基础 CRUD 已在 P0-15） | 提醒文案引用 SOP「连续使用 ≥4 周再评估」；联动统计数与记录页筛选结果一致 |
| P1-02 | 薄弱点排序算法 + 建议增量时长分配（§6.5 / §6.2） | Top3 展示必带依据三元组；增量分配受语法 20% 上限约束 |
| P1-03 | 数据修订历史（记录/单元的字段级 diff） | 任一记录可查看最近 10 次修改的前后值 |
| P1-04 | 全局搜索（记录/错题/单词/句子）与筛选组合保存 | 关键词命中 ≤ 300ms（本机 1 万条记录内） |
| P1-05 | 复习队列批量操作（批量标记完成 / 批量顺延） | 批量操作有二次确认与撤销提示 |
| P1-06 | 周报导出 PDF / 打印样式 | 打印样式隐藏导航与操作按钮 |
| P1-07 | AI 能力预留：`ai_suggestion` 表 + 服务层接口 + 依据展示区 | 无 API Key 时返回 `unavailable` 并显示「AI 未启用」，不阻塞任何主流程 |

### P2（Nice to have）

P2-01 语音/文字转写与发音评分（依赖第三方，第一期不做）｜ P2-02 Anki / CSV 词表批量导入导出｜ P2-03 五大句型、定语从句、非谓语的结构化扩展题型｜ P2-04 移动端离线缓存 + 后台同步｜ P2-05 学习曲线预测（基于历史速率的阶段完成日估算，须标注为估算，不得表述为承诺）

## 5. 页面功能规格

> 通用要求：每页必须有 **空状态**（说明该页依赖哪些前置数据 + 直达创建入口）、**加载态**（骨架屏）、**错误态**（可重试，不吞错误）、**破坏性操作二次确认**。所有日期显示为 `YYYY-MM-DD`，时长显示为 `Xh Ym`。

### 5.1 Dashboard 总览

- **目的**：30 秒内回答「我在哪、今天做什么、哪里最弱、有没有欠账」。
- **区块（共 12 块）**：①状态条（阶段名 + 开始日期 + 已进行天数 + 距预估上限剩余天数）②**四类量分区卡（不可混排）** 计划时长 / 实际净时长 / 有效产出数 / 知识掌握度（= 已 GREEN 单元占比 + 词汇三档分布）③今日（按时长加权的完成率 + 副指标任务数完成率 + 已完成/总任务 + 剩余分钟 + 下一任务按钮）④本周（净时长、完成率、与上周 ↑↓ 绝对差）⑤四项投入 听/读/说/写 实际净分钟（泛听泛读单列）⑥语法与词汇（EGIU 三色计数按最新判定、红灯未处理数、词汇累计/本周新增/抽测正确率）⑦待复习（今日到期 / 逾期 / 未来 7 天，点击进队列）⑧趋势（7 天、30 天净时长折线，空缺日断点不补 0）⑨薄弱点 Top3（名称 + 依据「错 X/Y 题·主要类别·趋势」+「加点时间」入口）⑩下一阶段验收完成度（passed/总数 进度环 + 未通过项名称）
- **异常态**：无记录 → 引导「先完成阶段 0 基线诊断」；仅 1 天数据 → 趋势图显示「数据不足，需 ≥2 天」。
- **禁止**：用打卡天数、连续天数、完成率单独宣称「能力提升」。

### 5.2 学习阶段与验收

- **时间线视图**：4 阶段卡片，每卡显示标准（引用 SOP）、预计区间、实际起止、验收 passed 数、状态（未开始/进行中/已完成/手动跳过）。
- **验收清单表**：7 行 × 列 `维度 | 标准（SOP 原文，只读） | 我的实际结果 | 证据链接 | 判定 | 判定日期`。
- **升级判定区**：`建议升级` 仅 §6.4 硬条件全满足时可用；不可用时以列表展示未满足项与差距。手动升级须填原因（≥10 字）。**文案约束**：阶段名一律「阶段一 · 基础英语（A0→A2 训练区间）」，禁止「CEFR A2 认证」「官方等级」等表述。

### 5.3 学习计划（日历 + 列表）

- **生成规则**：选阶段 + 日期 + 可用分钟 → 按 §6.2 生成 9 模块任务，顺序遵循 SOP 主线（词汇复习→语法句型→听力→阅读→口语→写作→句子成分→复盘→泛听泛读）。
- **列表视图**：每行 `时间块 | 模块 | 计划min | 实际min | 状态 | 关联资源 | 操作`，支持拖拽调序与就地改时长。
- **日历视图**：月视图，每格显示完成率 + 净时长 + 待复习数；颜色仅表达完成度，不表达能力。
- **任务操作与总结**：开始 / 暂停 / 完成 / 部分完成（必填实际分钟）/ 标记未完成（选原因：时间不足·状态差·材料不合适·其他）/ 顺延（选目标日）；完成当日自动生成可编辑总结草稿（净时长、各模块情况、产出清单、问题条目）。
- **约束校验**：S1 阶段语法类任务合计 ≤ 当日总时长 20%，超出时提示并推荐下调。

### 5.4 学习记录

- **通用字段（17）**：日期、阶段、科目、模块、资源、章节/单元、内容摘要、计划时长、实际时长、状态、总题数、正确数、正确率（自动算只读）、难度、产出、问题、错误类型、下次复习日期、备注。**科目扩展**见 §7 `study_record.ext`。
- **交互**：选科目后渲染对应扩展块；`正确率` 由 `correct/total` 实时计算；**保存前先校验 `correct ≤ total` 且题数/正确数/造句数 ≥ 0，校验不通过则报错且不落库**；仅当 `total=0` 且 `correct=0`（输入合法）时正确率留空并显示「无题量数据」；同时校验「产出」与「问题」至少填一项（G2）。
- **列表与空状态**：按日期倒序，可按科目/阶段/资源筛选；显示 `created_at / updated_at`。空态引导「从今日计划开始任务」或「手动补录」。

### 5.5 语法诊断（EGIU）

- **单元看板**：三列（GREEN/YELLOW/RED）+ PENDING 列；每卡显示单元编号、知识点、最近正确率、最近判定日期、下次复习日、复测次数。
- **单元详情链**：基础信息（教材/版本/编号/知识点）→ 判定输入（题数、正确数、能否解释规则、独立造句数、是否理解核心规则）→ 判定结果 + 命中规则说明（必须显示「为什么是黄灯」）→ 复习计划（D1/D3/D7/D14）→ 复测历史时间线 → 掌握度曲线（正确率折线 + 颜色带）。
- **约束**：每次复测新建 `egiu_review`，**禁止覆盖**历史；单元当前色 = 最近一次有效判定。空态提示新建单元或从资源库的 EGIU 资源生成清单。

### 5.6 错题与复习

- **错题库**：列 `原题 | 我的答案 | 正确答案 | 错误类别 | 知识点 | 来源 | 复习次数 | 最近复习 | 下次复习 | 已掌握`。错误类别 6 枚举（规则不理解/记忆混淆/词汇不认识/语序错误/粗心/其他）+ 雅思题型错因子枚举（词汇/定位/理解/注意力/策略，仅 S3 启用）。
- **复习队列**：三 Tab（今日 / 逾期 N 天 / 未来 7 天）；每条显示来源（EGIU 单元·错题·单词·语法点）、间隔档（D1/D3/D7/D14/+21/+30）、操作（通过 / 未通过 / 顺延 / 跳过并标注原因）。未通过 → 按 §6.3 追加后续复习点；通过 → 更新复习次数与下次日期。
- **空状态**：区分「无错题」与「有错题但无到期任务」。

### 5.7 词汇

- **今日面板**：新词（默认 18，范围 15–20，状态好可至 25）+ 复习词（到期数）两个进度条。
- **词条字段**：单词、音标、词性、中文释义、英文释义、搭配、例句、学习日期、掌握度、最近复习、下次复习、来源（Oxford 3000 / 手动）。
- **掌握度三档（单选，不可跳过）**：`认识但不能用` / `能理解` / `能主动使用`；列表与统计按三档分列，**禁止合并为单一「已掌握」**。**随机抽测**：随机 50–100 词逐词三档自评 → 加权正确率（1.0 / 0.7 / 0.3）+ 建议（<80% → 下调下周新词量）。空态提示导入 Oxford 3000。

### 5.8 句子成分

- **列表**：句子、中文、阶段、是否正确、错误原因、创建日期。
- **详情/新建**：原句输入 → 结构化标注每个意群：`成分（S/V/O/C/Adverbial）`、`词性（名词/动词/形容词/副词/介词/其他）`、`文本片段`。**词性与句子成分是两个独立下拉，取值集不重叠，禁止复用同一字段。**
- **阶段化重点**：S1 只显示 S/V/O/C + 状语；S2 增五大句型/定语/状语从句标记；S3 增非谓语/从句/被动。空态提示「可从当天 EGIU 单元挑 3–5 句」。

### 5.9 每周复盘

- **13 项指标表**（自动填充，可手工覆盖且覆盖留痕）：净时长、每日分布、各任务完成率、听力次数与结果、阅读次数与结果、口语录音次数与总时长、写作篇数与字数、语法单元数、三色数量变化、错题新增与复测通过、词汇量与抽测正确率、最高频错误类型、与上周对比。
- **下周 Top3 薄弱点**：必须选满 3 项（来自薄弱点候选池，可手工改），选定后写回下周计划生成偏好。
- **导出与空态**：Markdown / PDF / 打印三视图；本周无记录时允许生成「空周报」但标注「本周无有效记录」。**同页含「数据分析」Tab**（见 §5.10）。

### 5.10 数据分析（「每周复盘」页内 Tab，非独立一级页面）

- **入口路径**：每周复盘页顶部 Tab `?tab=analytics`；Dashboard 的「7 天 / 30 天趋势」与「四项投入」区块点击「查看全部」直达同一点位。无独立导航项（原因见 §3 导航决策）。
- **10 张图**：①每日净时长趋势 ②每周净时长趋势 ③听说读写分布 ④各阶段投入分布 ⑤EGIU 三色分布 ⑥语法正确率趋势 ⑦词汇积累趋势（累计/新增双轴） ⑧每周完成率 ⑨错题类型分布 ⑩各科目记录历史（时间轴/热力）。
- **筛选与空态**：日期范围、阶段、科目、教材，变更即全量重算，所有图可点击下钻到原始记录；`total=0` 的图显示「暂无数据」占位，不渲染零值曲线。

### 5.11 系统设置

- **学习目标**：雅思目标分（总分 + 四单项，0.5 步进，初始 6.0–6.5）、长期目标标签「B2（训练目标，非认证）」、目标考试日期。
- **时间与时长**：每日可用分钟（240 / 270 / 300 预设 + 自定义）、专注块（默认 45–50min）、休息（默认 5–10min，**不计入净学习时长**）、时区（固定 Asia/Singapore，只读 + 说明）。
- **资源库数据维护**：资源 CRUD 已独立为一级页面「资源库」（规格见 §5.12），设置内**只保留**「初始 8 类资源重置 / 批量导入导出」两项运维操作，不再承载日常增删改。
- **导出与备份**：全量 JSON（含 schema_version、导出时间、记录数）、按表 CSV、每日自动备份保留最近 7 份。
- **AI 配置（预留）**：开关、Provider、Key（本地保存）、连通性测试；关闭时全站不显示 AI 入口。**关于与免责**：常驻免责声明（见 §9）。

### 5.12 资源库（一级页面）

- **目的**：管住「材料不换」这条 SOP 规则——每项能力固定一个主材料并连续使用 ≥4 周，避免每天换书。
- **资源清单**：表格列 `名称 | 科目 | 类型 | 适用阶段 | 版本 | 总章节 | 当前进度 | 开始/完成日期 | 链接 | 操作`；支持按科目/阶段筛选、按使用中优先排序。
- **资源详情与进度**：显示该资源关联的记录数与 EGIU 单元数（间接反映实际使用），以及「使用时长是否已满 4 周」。
- **新增 / 编辑**：字段见 §7 E14；初始 8 类资源为**数据行**（EGIU、English Grammar in Use 中级、Oxford 3000、English Pronunciation in Use Elementary、British Council/VOA、Oxford Bookworms/Penguin Readers、Reading Explorer、Cambridge IELTS），代码中不得出现资源枚举。
- **换材料提示**：在阶段内变更某能力的主材料时弹出提醒「SOP 建议连续使用 ≥4 周再评估」，用户确认后记录变更时间与原因；**不做硬拦截**。
- **空状态**：无资源时引导「重置为初始 8 类资源」或手动新增。

## 6. 业务规则的可执行定义（核心）

### 6.1 EGIU 三色判定

**输入**：`total`（本次题数）、`correct`、`explainOK`（能否用自己的话说出规则）、`sentences`（独立造出的新句子数）、`coreRuleOK`（是否理解核心规则）。

```
function judgeColor(total, correct, explainOK, sentences, coreRuleOK):
  # 1 输入合法性校验（必须先于空题量判断，否则脏数据会被静默判成 PENDING）
  if total < 0 or correct < 0 or sentences < 0:
      return { ok: false, code: "NEGATIVE_INPUT" }

  if correct > total:
      return { ok: false, code: "CORRECT_GT_TOTAL" }

  # 2 数据不足（仅在输入合法后判定）
  if total == 0:
      return { color: PENDING, reason: "题量为 0，不判定，不生成复习计划" }

  acc = correct / total

  # 3 硬否决（SOP：不理解核心规则 → 红灯，与正确率无关）
  if coreRuleOK == false:
      return { color: RED, reason: "不理解核心规则（硬否决）" }

  # 4 题量充足（total >= 5）：正确率可信，按 SOP 三色表直接映射
  if total >= 5:
      if acc >= 0.90 and explainOK and sentences >= 2:
          return { color: GREEN,  reason: "正确率≥90% + 能说规则 + 造句≥2" }
      if acc >= 0.90:
          return { color: YELLOW, reason: "答案对但解释不清/造句不足（SOP：答案对但解释不清=黄灯）" }
      if acc >= 0.70:
          return { color: YELLOW, reason: "正确率 70%–89%" }
      return { color: RED, reason: "正确率 <70%" }

  # 5 题量过少（1 <= total <= 4）：正确率降权（权重 30%），解释 40% + 造句 30%
  else:
      accScore  = acc * 0.30
      explScore = explainOK ? 0.40 : 0
      sentScore = sentences >= 2 ? 0.30 : (sentences == 1 ? 0.15 : 0)
      S = accScore + explScore + sentScore        # 0 ~ 1.0
      if explainOK and sentences >= 2 and S >= 0.85:
          return { color: GREEN,  reason: "题量少但解释+造句双达标且综合分≥0.85 (S=" + S + ")" }
      if explainOK or sentences >= 2:
          return { color: YELLOW, reason: "题量少，证据不全，需补测 (S=" + S + ")" }
      return { color: RED, reason: "题量少且解释/造句均不达标 (S=" + S + ")" }
```

> **修订说明（2026-11-09）**：输入校验（`correct > total`、负数）必须先于空题量判断。否则脏数据会被误判为 PENDING 而不报错。本修订只影响非法输入的处置，不改变任何合法输入的判定结果。

**判定示例（可直接作为单测用例）**

| total | correct | explainOK | sentences | coreRuleOK | 结果 | 命中依据 |
|---|---|---|---|---|---|---|
| 10 | 9 | true | 2 | true | GREEN | 题量充足 + ≥90% + 规则 + 造句 |
| 10 | 9 | false | 2 | true | YELLOW | 答案对但解释不清 |
| 10 | 7 | true | 2 | true | YELLOW | 70%–89% |
| 10 | 6 | true | 2 | false | RED | 硬否决（不理解核心规则） |
| 8 | 8 | true | 0 | true | YELLOW | 全对但未造句，不达绿灯 |
| 3 | 3 | true | 2 | true | GREEN | 题量少但解释+造句双达标，S=0.30+0.40+0.30=1.00 |
| 3 | 1 | false | 0 | true | RED | 题量少且解释/造句均不达标，S=0.10 |
| 4 | 3 | true | 1 | true | YELLOW | 解释达标，造句仅 1 个，S=0.225+0.40+0.15=0.775 |
| 0 | 0 | — | — | — | PENDING | 题量为 0（输入合法），不判定、不排程 |
| 0 | 3 | — | — | — | **错误 CORRECT_GT_TOTAL** | 脏数据，不得判 PENDING（输入校验在空题量之前） |
| -1 | 0 | — | — | — | **错误 NEGATIVE_INPUT** | 负数输入，不进入任何判定档 |

**边界约定**

1. `sentences` 指「独立造出的、正确的、非原题的新句子数」，由用户如实填写，系统不自动判语法。
2. 单元当前颜色 = **最近一次有效判定**（PENDING 不覆盖历史颜色，仅标记「待补测」）。
3. 每次判定必须持久化 `reason`（命中规则），UI 上向用户显示「为什么是黄灯」。
4. 分支顺序固定为：**输入合法性校验（负数 → `correct > total`）→ PENDING → 硬否决 RED → 正确率档 → 题量降权档**，不得调换。校验失败返回 `{ ok: false, code }`（`NEGATIVE_INPUT` / `CORRECT_GT_TOTAL`），**不返回颜色**；调用方必须提示数据录入错误，禁止降级为 PENDING。
5. 平均每天测试 3–5 个单元为**建议节奏**，不作为强制上限；不因未达数量而阻断使用。

### 6.2 每日计划生成与增量分配

```
基础版（默认 240min，与 SOP §2 表一致，不可改数值）：
VOCAB_REVIEW 25 · GRAMMAR 40 · LISTENING 45 · READING 40 · SPEAKING 30
WRITING 20 · SENTENCE 15 · REVIEW_PLAN 10 · EXTENSIVE 15   → 合计 240

若 dailyMinutes in (240, 270]: extra = dailyMinutes - 240      # 30min
若 dailyMinutes in (270, 300]: extra = dailyMinutes - 240      # 30–60min
若 dailyMinutes < 240 或 > 300: 拒绝并提示取值范围
```

**增量分配顺序（冲突已裁决）**

1. `REVIEW_PLAN` 固定 10min，不增不减（SOP 明确「保持 10 分钟」）。
2. `SENTENCE` 阶段一不增加；S2/S3 最多 +5。
3. **剩余增量按薄弱点 Top3（§6.5）分配**——满足业务方「额外 30–60 分钟优先给薄弱项」。
4. **SOP 约束优先**：S1 阶段 `GRAMMAR ≤ 总时长 × 20%`（240→48、300→60）；若薄弱项为语法，其单项增量上限 = 该上限 − 40。
5. 单科目单日增量上限 15min（`SPEAKING`/`LISTENING`/`READING` 可至 20min，对齐 SOP「优先给听力精听、阅读和口语」）。
6. 若 Top3 某维度不在 9 模块内（如「弱读连读」属 SPEAKING 子项），映射到其父模块。
7. 分配后必须通过校验：`sum == dailyMinutes` 且各项 ≥ 0；否则回退为「按 SOP 扩量表等比例分配」。

**任务排序**：严格按 SOP 主线 `VOCAB_REVIEW → GRAMMAR → LISTENING → READING → SPEAKING → WRITING → SENTENCE → REVIEW_PLAN → EXTENSIVE`，允许用户手动调序并持久化。

### 6.3 复习日期生成规则（D1/D3/D7/D14）

起算日 `D0 = 该单元/错题/单词的「首测日期」(learned_date)`，**不是**复习执行日，也**不是**创建时间（补录时以用户填写的学习日期为准）。

| 触发判定 | 生成复习点 | 该点内容（引用 SOP §7） |
|---|---|---|
| GREEN | 不生成结构化复习点，纳入 D7 周抽测池 | 抽测一周内容 |
| YELLOW | D1、D3、D7 | D1 回忆规则与词汇；D3 重做黄/红题；D7 抽测 |
| RED | D1、D3、D7、D14 | 追加 D14 复测长期易错点 |
| PENDING | 不生成 | — |

**复测后追加（不覆盖原计划）**

```
若 D3 复测仍为 YELLOW → 追加 D7（若已存在则跳过）、D14
若 D7 复测仍为 RED   → 追加 D14、D21、D30
若 D14 复测仍为 RED  → 追加 D21、D30，此后每 30 天一次，不设上限
同一 knowledge_point 最多同时存在 4 个未完成的未来复习点（超出则合并到最近的未完成点）
```

**边界处理（明确裁决）**

1. **周末/节假日不顺延**：本产品是个人学习，无工作日概念，复习日按自然日 `D0 + n` 计算。仅当目标日无任何计划任务时才在 UI 上提示「该日为休息日，是否移至下一有学习安排的日期」，由用户主动确认，系统不自动改期。
2. **逾期不消失**：到期未完成 → 保留在「逾期」Tab，标记 `overdue_days`；逾期**不改变**后续复习点的原定日期（D3 没做不导致 D7 后移），避免雪崩式顺延。
3. **已掌握停止**：同一知识点连续 2 次复测为 GREEN，且最近两次复测间隔 ≥ 7 天 → 置 `mastered_at`，停止生成新复习点，转入**低频抽测池**（每 30 天随机抽 1 次）；抽测失败（非 GREEN）→ 清除 `mastered_at`，从 D1 重新开始。
4. **日容量上限**：单日复习任务预估总分钟 > 可用时长的 25% → UI 提示「复习负载过重」，并给出「今天优先处理 X 个红灯」的建议，但不强制截断（不隐藏任务）。
5. **时区**：所有日期计算在 Asia/Singapore 下按日历日进行，日期仅存 `DATE` 不存时刻，避免跨时区偏移。
6. **跨零点计时**：session 跨 24:00 时按分钟占比拆分到两个自然日，保证「日净时长」不虚高。

### 6.4 阶段「建议升级」判定

**硬条件（必须全部满足，缺一即不升级）**

| 代号 | 条件 | 判定数据源 |
|---|---|---|
| H1 | 该阶段 7 维度验收清单中「必验项」全部 `passed`（必验项 = 听力、阅读、口语、写作、语法各 ≥1 项） | `stage_acceptance_item` |
| H2 | 每个 `passed` 项都填了「我的实际结果」与非空证据链接/文本，且 `judged_at` 在阶段内 | 同上 |
| H3 | 近 14 天 D7+D14 复习任务完成率 ≥ 80% | `review_task` |
| H4 | 近 30 天内，日净时长 ≥ 240min 的天数占比 ≥ 80%（仅统计有计划的日期） | `study_session` + `plan_task` |
| H5 | 该阶段无未处理红灯：所有 EGIU/语法单元最新判定 ∈ {GREEN, YELLOW}，或红灯均已重学并复测至 YELLOW 以上 | `egiu_lesson` |

**参考项（不阻断，仅展示并计入完成度环）**：词汇量区间（S1 1500–2500 / S2 3000–4000 / 词汇不作唯一通关条件）、词汇抽测正确率 ≥80%、S3 的模考次数 ≥2 且最近 2–3 次结果相对稳定并达到个人目标分、单项最低分要求。

**输出**：`{ suggested: boolean, unmet: [{code, current, target}], evidenceSnapshot }`。系统**永不**自动切换阶段。手动升级/降级必须填 `reason`（≥10 字），写 `stage_transition_log(from_stage, to_stage, decided_at, decided_by, reason, evidence_snapshot)`，且不得删除历史记录。

### 6.5 薄弱点排序算法（Top3）

候选维度 d = 科目级（6 类）或知识点级（EGIU 单元/错误类别），近 28 天窗口。

```
errRate_d    = 该维度错题数 / max(1, 该维度总题数)              # 0–1
accGap_d     = max(0, 该科目近28天加权均正确率 − 该维度加权均正确率)   # 0–1
investGap_d  = clamp((计划分钟 − 实际净分钟) / 计划分钟, 0, 1)
reviewDebt_d = 该维度逾期复习任务数 / max(1, 该维度复习任务总数)
redDensity_d = 该维度红灯单元数 / max(1, 该维度单元总数)

weakness_d = 0.35*errRate_d + 0.25*accGap_d + 0.15*investGap_d
           + 0.15*reviewDebt_d + 0.10*redDensity_d
```

- **去重**：同一 key 在多来源出现只计 1 次，取各分项最大值（不累加，防重复放大）。
- **样本阈值**：该维度总题数 < 10 → 不参与排序，单列「数据不足，暂不排序」。
- **投入缺口权重最低（0.15）**：明确「花时间少 ≠ 能力弱」，避免算法退化为「谁练得少就补谁」。
- **输出必带依据**：`{ name, score, evidence: "错 7/12 题 · 主要类别=记忆混淆 · 较上周↑3", actionHint }`。
- **稳定性**：同一周内 Top3 由系统计算后允许用户手工调整，手工调整结果在下次周复盘前保持不变（防止每天变化的榜单失去行动价值）。

### 6.6 聚合口径（防重复统计）

| 指标 | 口径 |
|---|---|
| 单次正确率 | `correct / total`；`total = 0 → null`，**null 不计入任何均值，也不当 0** |
| 平均正确率 | 一律**加权**：`Σcorrect / Σtotal`。**严禁对 accuracy 数组取算术平均** |
| 参与统计的记录 | `status ∈ {已完成, 部分完成}` 且 `total > 0`；按 `record_id` 去重（编辑后以最新值为准，不重复计一条） |
| 净学习时长 | `Σ session 实际时长`；单 session 实际时长 = `min(计时时长, 计划时长 × 1.5)`（防挂机，超限打 `anomaly` 标）；`实际 < max(3min, 计划×0.2)` 视为误触记 0；中断（>30min 无操作）区间剔除；**休息不计入** |
| 日净时长 | 按 Asia/Singapore 自然日切分，跨零点按分钟占比拆分 |
| 任务完成权重 | 已完成=1.0；进行中/部分完成 = `clamp(实际min/计划min, 0, 1)`；未完成/待开始=0 |
| 日/周计划完成率 | **按时长加权**：`Σ(权重 × 计划min) / Σ(计划min)`；周完成率 = 先聚合全周分子分母再相除，**不取日均值的平均**（避免空日拉低）；另设「任务数完成率」为副指标 |
| 顺延任务 | 原日分母剔除（`moved_out`），目标日分母计入（`moved_in`），保证既不重复也不遗漏 |
| 趋势分桶 | 日趋势按自然日，无记录日 = null（折线断点，不补 0）；周趋势按 ISO 周（周一起），当周不完整标 `partial` |
| 四项投入 | 每个 session 只归属 1 个 skill；`EXTENSIVE`（泛听泛读）独立成桶，**不并入**听力/阅读精练统计 |
| 三色分布 | 每 Lesson 只取**最新一次判定**计 1 次（非历史全部判定） |
| 词汇正确率 | 加权：`能主动使用=1.0 / 能理解=0.7 / 认识但不能用=0.3`，`Σ权重 / 词数` |

## 7. 数据字典（14 核心实体 + 2 辅助表）

字段行格式：`字段` 类型 必填性 说明/枚举。约定 `PK` 主键、`FK` 外键、`*` 必填、`｜` 分隔字段；日期为 `DATE`、时刻为 `TIMESTAMP`、时区统一 `Asia/Singapore`。删除一律软删除（`deleted_at`）。

**E1 `user_profile`（单用户，固定 1 条）**
`id` int PK* =1 ｜ `target_band_overall` decimal(2,1)* 0.5 步进，默认 6.5 ｜ `target_band_listen/read/write/speak` decimal(2,1) 可空 ｜ `daily_minutes` int* 60–600，默认 240 ｜ `timezone` string* 固定 `Asia/Singapore`（只读）｜ `exam_date` date ｜ `ai_enabled` bool* 默认 false

**E2 `stage`**
`id` PK* ｜ `code` enum* `S0_PREP`/`S1_A0_A2`/`S2_A2_B1`/`S3_B1_IELTS` ｜ `name_zh` string* 如「阶段一 · 基础英语（A0→A2 训练区间）」 ｜ `est_days_min`/`est_days_max` int* S0 1–2、S1 120–180、S2 90–120、S3 90–150（上限可空=「或更久」）｜ `status` enum* `NOT_STARTED`/`ACTIVE`/`COMPLETED`/`SKIPPED` ｜ `started_at`/`completed_at` date

**E3 `stage_acceptance_item`**
`id`/`stage_id` PK/FK* ｜ `dimension` enum* `LISTENING`/`READING`/`SPEAKING`/`WRITING`/`GRAMMAR`/`VOCAB`/`SENTENCE` ｜ `is_required` bool* 必验项（H1 依据）｜ `criterion_text` text* SOP 原文只读 ｜ `my_result` text 实际测试结果 ｜ `evidence` text 链接或文本 ｜ `verdict` enum* `PENDING`/`PASSED`/`FAILED` ｜ `judged_at` date（verdict≠PENDING 时必填）

**E4 `plan_task`**
`id`/`stage_id` PK/FK* ｜ `plan_date` date* ｜ `module` enum* `VOCAB_REVIEW`/`GRAMMAR`/`LISTENING`/`READING`/`SPEAKING`/`WRITING`/`SENTENCE`/`REVIEW_PLAN`/`EXTENSIVE` ｜ `skill` enum* `VOCAB`/`GRAMMAR`/`LISTENING`/`READING`/`SPEAKING`/`WRITING`/`SENTENCE`/`META`（泛听泛读→`LISTENING_EXT`/`READING_EXT`）｜ `planned_minutes` int* >0 ｜ `sort_order` int* ｜ `status` enum* `TODO`/`IN_PROGRESS`/`DONE`/`PARTIAL`/`MISSED` ｜ `actual_minutes` int 由 session 汇总只读 ｜ `moved_from_date`/`moved_to_date` date 顺延标记 ｜ `resource_id` FK ｜ `note` text

**E5 `study_session`（计时执行单元，一个 task 可多 session）**
`id`/`task_id` PK/FK* ｜ `started_at`/`ended_at` timestamp* ｜ `active_minutes` int* 剔除中断后的净计时 ｜ `idle_minutes` int 中断合计 ｜ `count_ratio` decimal* `clamp(active/planned,0,1.5)`，净时长计算依据 ｜ `anomaly_flag` bool* 超 1.5 倍或误触 ｜ `terminated_reason` enum `COMPLETED`/`PAUSED`/`ABANDONED`/`MOVED`/`TIMEOUT`

**E6 `study_record`（核心）**
`id`/`stage_id`/`task_id` PK/FK* ｜ `record_date` date* ｜ `skill` enum* 同 task ｜ `resource_id`/`chapter` FK/string ｜ `content` text* ｜ `planned_minutes`/`actual_minutes` int* ｜ `status` enum* 同 task ｜ `total_questions`/`correct_questions` int ≥0 且 correct≤total ｜ `accuracy` decimal 生成列只读 ｜ `difficulty` enum `EASY`/`MEDIUM`/`HARD` ｜ `output_text` text 可检查产出（G2）｜ `problem_text` text ｜ `error_types` json[] 多选 ｜ `next_review_date` date ｜ `ext` json 分科扩展 ｜ `created_at`/`updated_at` timestamp*（编辑不改 created_at）

**`study_record.ext` 分科扩展**
- 听力：`audio_name`、`audio_minutes`、`gist_blind`（盲听主旨）、`key_info`、`unclear_segments`、`shadowing_done`（bool）、`retell_points_zh`
- 阅读：`article_name`、`word_count`、`pages`、`new_word_count`、`gist`、`comprehension_accuracy`、`summary_en`
- 口语：`topic`、`recording_minutes`、`shadowing_count`、`independent_speech_minutes`、`grammar_errors[]`、`pronunciation_issues[]`、`pause_count`、`recording_url`
- 写作：`topic`、`task_type`（`SENTENCE`/`DIARY`/`PARAGRAPH`/`ESSAY_150_200`/`TASK1`/`TASK2`）、`word_count`、`time_spent_min`、`grammar_error_count`、`spelling_error_count`、`revised`（bool）、`draft_text`、`revised_text`

**E7 `egiu_lesson`**
`id`/`stage_id`/`resource_id` PK/FK* ｜ `book`/`version`/`unit_no` string* ｜ `knowledge_point` string* ｜ `current_color` enum* `PENDING`/`GREEN`/`YELLOW`/`RED`（=最近一次有效判定）｜ `learned_date` date* 首测日期（D0 起算依据）｜ `mastered_at` timestamp（连续 2 次 GREEN 且间隔≥7 天写入）｜ `next_review_date` date 最近未完成复习点 ｜ `retest_count` int* 默认 0

**E8 `egiu_review`（每次复测独立，禁止覆盖）**
`id`/`lesson_id` PK/FK* ｜ `review_date` date* ｜ `review_stage` enum* `D0`/`D1`/`D3`/`D7`/`D14`/`D21`/`D30`/`MANUAL` ｜ `total_questions`/`correct_questions` int* ｜ `accuracy` decimal 生成列 ｜ `explain_ok`/`sentences_count`/`core_rule_ok` bool/int/bool* 三色输入 ｜ `judged_color` enum* `GREEN`/`YELLOW`/`RED`/`PENDING` ｜ `judge_branch` enum* `ZERO`/`OVERRIDE`/`FULL`/`LOW_VOLUME` ｜ `judge_reason` text* 命中规则，UI 必须展示 ｜ `error_breakdown` json `{rule_unclear, memory_confusion, careless, vocab}` 计数

> `judge_branch` 记录**命中哪个判定分支**（`ZERO` 题量为 0 / `OVERRIDE` 硬否决 / `FULL` 题量充足档 / `LOW_VOLUME` 降权档），是追溯「这个单元为什么被判成红灯」的机器可读证据，与 `judge_reason` 的自由文本互为佐证。用途仅限**追溯与审计**，展示层不直接呈现给用户（用户只看颜色与 `judge_reason`）。

**E9 `mistake`**
`id`/`stage_id` PK/FK* ｜ `source_type`/`source_id` enum/int* `EGIU_REVIEW`/`STUDY_RECORD`/`MANUAL`/`VOCAB` ｜ `original_question`/`my_answer`/`correct_answer` text* ｜ `error_reason` text* ｜ `knowledge_point` string* 薄弱点聚合键 ｜ `error_category` enum* `RULE_NOT_UNDERSTOOD`/`MEMORY_CONFUSION`/`VOCAB_UNKNOWN`/`WORD_ORDER`/`CARELESS`/`OTHER` ｜ `ielts_error_category` enum `VOCAB`/`LOCATING`/`COMPREHENSION`/`ATTENTION`/`STRATEGY`（仅 S3）｜ `review_count` int* 默认 0 ｜ `last_review_at`/`next_review_at` date ｜ `is_mastered` bool* 默认 false ｜ `created_at` timestamp*

**E10 `review_task`（统一调度，避免多套调度器）**
`id` PK* ｜ `target_type`/`target_id` enum/int* `EGIU_LESSON`/`MISTAKE`/`VOCAB_WORD`/`GRAMMAR_POINT` ｜ `interval_code` enum* `D1`/`D3`/`D7`/`D14`/`D21`/`D30`/`LOW_FREQ_30` ｜ `due_date` date* ｜ `status` enum* `PENDING`/`DONE`/`SKIPPED`/`SUPERSEDED` ｜ `overdue_days` int 生成列 ｜ `result` enum `PASS`/`FAIL`（DONE 时必填）｜ `completed_at` timestamp ｜ `est_minutes` int* 日容量负载计算（§6.3 边界 4）

**E11 `vocab_word`**
`id` PK* ｜ `word`/`phonetic`/`part_of_speech` string* ｜ `meaning_zh`/`meaning_en` string* ｜ `collocation`/`example_sentence` text ｜ `source` string* `Oxford3000`/手动 ｜ `learned_date` date* ｜ `mastery` enum* `RECOGNIZE_ONLY`（认识但不能用）/`COMPREHEND`（能理解）/`ACTIVE_USE`（能主动使用）｜ `last_review_at`/`next_review_at` date ｜ `is_new` bool* 「今日新词」统计

**E12 `sentence_analysis`**
`id`/`stage_id` PK/FK* ｜ `sentence_en`/`sentence_zh` text* ｜ `tokens` json[]* `[{text, component, pos}]` ｜ `component` 取值 enum* `S`/`V`/`O`/`C`/`ADVERBIAL` ｜ `pos` 取值 enum* `NOUN`/`VERB`/`ADJ`/`ADV`/`PREP`/`PRON`/`OTHER`（**与 component 取值集不重叠，字段隔离**）｜ `is_correct` bool* ｜ `error_reason` text（false 时必填）｜ `pattern_tag` enum `FIVE_PATTERNS`/`RELATIVE_CLAUSE`/`ADVERBIAL_CLAUSE`/`NON_FINITE`/`PASSIVE` ｜ `source_record_id` FK

**E13 `weekly_review`**
`id` PK* ｜ `iso_year`/`iso_week` int* 唯一 ｜ `week_start`/`week_end` date* 周一/周日 ｜ `metrics` json* 13 项快照（自动值 + 手工覆盖值 + 覆盖时间）｜ `is_partial` bool* ｜ `top3_weaknesses` json[]* `[{name, score, evidence, manual}]` 必须 3 项 ｜ `review_note` text ｜ `exported_at` timestamp

**E14 `resource`**
`id` PK* ｜ `name` string* ｜ `subject` enum* `GRAMMAR`/`VOCAB`/`PRONUNCIATION`/`LISTENING`/`READING`/`SPEAKING`/`WRITING`/`EXAM` ｜ `type` enum* `BOOK`/`WORDLIST`/`WEBSITE`/`AUDIO_SERIES`/`GRADED_READER`/`EXAM_PAPER` ｜ `applicable_stage` enum* `S0`–`S3` 或多选 ｜ `version` string ｜ `total_units`/`current_unit` int 进度计算 ｜ `start_date`/`finish_date` date ｜ `url`/`note` string/text

**辅助表**
- `stage_transition_log`：`from_stage`、`to_stage`、`decided_at`、`decided_by`（`SYSTEM_SUGGESTED`/`USER`）、`reason`*、`evidence_snapshot` json — **只增不删**。
- `daily_summary`：`summary_date`*、`net_minutes`、`completion_rate`、`outputs` json、`issues` json、`generated_at`。

**全局枚举与约束**
- 只允许一个 `status = ACTIVE` 的 `stage`。
- `egiu_lesson` 与 `stage` 的 `stage_id` 仅允许 `S1`/`S2`（S0/S3 不使用 EGIU 单元判定）。
- `review_task` 与 `target_*` 必须存在对应实体（引用完整性）。
- 所有 `*_date` 禁止存时刻；跨日拆分仅在 `study_session` 层处理。

## 8. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能与容量 | 首屏可交互 ≤ 2.5s；Dashboard 全量聚合 ≤ 500ms；图表换筛选 ≤ 300ms；记录保存 ≤ 200ms 乐观更新。目标 3 年数据：记录 ≤ 8 万条、词汇 ≤ 6000、错题 ≤ 3 万；列表虚拟滚动 ≥ 1000 行流畅 |
| 时区 | 全局 Asia/Singapore；所有日期运算走统一工具函数，禁止在组件内 `new Date()` 直算；SQL 侧用本地日期列而非时区转换 |
| 响应式断点 | `<600` 手机（底部导航 + 卡片流，表格转卡片，图表横向滚动；图表降级为数值列表）／`600–1024` 平板（双列）／`≥1280` 桌面（侧栏 + 三列，表格全展示） |
| 可访问性与可测试性 | 对比度 ≥ 4.5:1；三色状态必须配文字/图标（不得仅靠颜色区分，色盲可达）；全键盘可操作；`focus` 可见；图表提供 `aria-label` 与数据表替代。三色判定、复习日程、完成率、薄弱点排序四个纯函数必须可单测并覆盖 §6 全部分支 |
| 数据持久化 | 必须落库（非 localStorage/内存）。浏览器关闭、崩溃、刷新后数据零丢失；计时状态需持久化以支持中断恢复 |
| 数据安全与备份 | 纯本地，不上传；每日自动备份保留 7 份；导出 JSON 含 `schema_version` 与校验和；导入前做 schema 校验与「覆盖/合并」二次确认；破坏性操作二次确认 + 可撤销提示 |
| 国际化与文案一致性 | 简体中文 UI，英文术语不翻译，所有文案集中在文案层。「计划时长 / 实际时长 / 有效产出 / 知识掌握」四个概念在 UI 上使用固定词，不得混用「进度」「完成度」等模糊词指代不同概念 |

## 9. 风险与合规措辞

| 风险 | 说明 | 措施 |
|---|---|---|
| CEFR 表述越界 | 阶段名含 A0–B2，易被误解为官方等级 | 阶段名固定为「阶段一 · 基础英语（A0→A2 **训练区间**）」；关于页与阶段页常驻「阶段对应关系为学习路径规划，**非 CEFR 官方认证或测评结果**」 |
| 雅思分数误读 | 目标分/模考分易被当官方成绩 | 所有分数统一前缀「个人目标分 / 我的模考记录（非官方成绩）」；导出周报含同款声明 |
| 时长替代能力 | 高时长产生虚假进步感 | Dashboard 四类量分区强制并置；禁止「连续打卡 N 天」类叙事；G2 产出缺失率作为质量指标 |
| 自动升级误导 | 用户期望系统代劳决策 | 系统只出「建议」，按钮禁用态需列出未满足项，证据快照可查 |
| AI 结论污染数据 | AI 建议被误当学习成绩 | AI 输出写入独立 `ai_suggestion` 表，UI 上与学习成绩物理分区，强制展示「依据」字段，标注「AI 建议，仅供参考」 |
| 数据丢失 | 单机无云同步 | 每日自动备份 + 导出提醒（≥7 天未导出时提示） |

**SOP 三条不可变规则在产品中的落地**：①不按天数机械升级 → §6.4 硬条件、无自动开关；②不换教材 → 资源库在阶段内变更时提示「SOP 建议每项能力固定主材料连续使用 ≥4 周」并记录变更；③每次学习必须产生可检查结果 → 记录表单「产出/问题」至少一项必填。

## 10. 待确认问题与默认决策

> 依业务方要求「非关键细节采用合理默认值、不频繁打断」，每条给出已采用的默认决策，开发直接按默认执行，后续可改配置。

| # | 问题 | 我们采用的默认决策 |
|---|---|---|
| Q1 | 每日计划未完成，跨日如何结算？ | 当日 24:00 未结束的任务自动置 `MISSED`，不自动顺延；用户可手动顺延（单任务最多顺延 2 次，超出提示「该模块连续滞后，建议下调计划时长」）。原日完成率按实际计权，不回填 |
| Q2 | 题量 <5 时是否必须补测？ | 是。判 YELLOW 且 `total<5` 时自动追加一个 `+2` 天的「补测」复习点（标 `MANUAL` 档），补测题量建议 ≥5；补测仍 <5 则按降权算法结果定档，不再强制 |
| Q3 | 阶段 S0（准备与诊断）是否生成 9 模块计划？ | 不生成。S0 仅生成 3 个任务：基线听力、基线阅读、基线口写（1 分钟录音 + 5–8 句写作），合计约 90min，用于填验收清单初值 |
| Q4 | 词汇「今日新词」默认数量？ | 18 个（15–20 区间中位）；上周抽测正确率 <80% → 下周自动降为 12 并提示；≥90% 可自动升为 22（上限 25） |
| Q5 | 「有效产出」的判定标准 | 满足任一即算：①有正确率（total>0）②有 `output_text` ≥20 字 ③有 `recording_url` ④有关联错题 ≥1 ⑤有英文摘要。泛听泛读只需「持续接触时长 ≥ 计划 80%」即可算弱产出（单列不计入强产出） |
| Q6 | 阶段超出预计区间怎么办？ | 不判失败、不自动升级；UI 标「已超预估区间 N 天」并展示未满足验收项，把决策权交还用户 |
| Q7 | 中断多长算「中断」？ | 计时中 >30 分钟无任何页面交互（含切走标签页）→ 暂停计时并把该区间计入 `idle_minutes`；回来自动提示「继续 / 结束并标记部分完成 / 作废」 |
| Q8 | 学习记录能否补录历史日期？ | 能。补录时 `record_date` 由用户选，`learned_date` 以此为 D0 起算，`created_at` 记实际录入时间，两者在 UI 上分别展示 |
| Q9 | 周复盘固定在哪一天？ | 默认周日，可在设置改为任意星期；未在当天完成时保留「待复盘」提醒至下一周开始 |
| Q10 | 泛听泛读计入净学习时长吗？ | 计入总净时长，但不计入「听力/阅读训练次数」与四项投入的精练时长，独立成桶，避免虚高 |
| Q11 | 数据存储形态（SQLite / IndexedDB / 其他） | 交架构师决策。硬约束：必须跨会话持久、可导出全量 JSON、支持事务、单机不依赖外部服务 |
| Q12 | 「资源库」与「数据分析」各自放几级导航？ | 已裁决（2026-11-09）：**资源库为一级页面**（对应业务方原文「学习资源」）；**数据分析不单列一级导航**，作为「每周复盘」页内 Tab（`/weekly?tab=analytics`），从 Dashboard 图表区块与周报页进入。一级导航稳定为 11 项，与业务方原文的 11 个主要页面一一对应。 |

---

**文档结束** ｜ 后续消费者：架构师（技术方案与任务拆分）、工程师（实现）、QA（验收用例，重点覆盖 §6 全部分支）
