/**
 * 种子数据。
 *
 * 只写「定义型数据」：
 *   v1.5 —— 单用户配置、4 个阶段、每阶段 7 条验收项（共 28 条）、8 类初始资源。
 *   v2.0 —— 3 条学习目标 + 里程碑骨架、5 档四技能配比档案、Stage.profileCode 回填、
 *           既有 PlanTask 的 track/primarySkill 回填。
 *
 * 刻意**不写**任何学习记录 / 错题 / 词汇假数据 ——
 * Dashboard 与图表必须只反映真实使用产生的数据，用假数据冒充统计会让整个产品失去意义。
 *
 * 全部写入均幂等（upsert 或「有则跳过」），可反复执行；这也是 v2 增量迁移的回填脚本口径。
 */

import { PrismaClient } from '@prisma/client';
import {
  GOAL_TYPES,
  GOAL_TYPE_LABEL_ZH,
  MODULE_TO_PRIMARY,
  MODULE_TRACK,
  STAGE_ALLOCATION,
  STAGE_CODE_TO_PROFILE,
  STAGE_PROFILE_CODES,
} from '../src/lib/constants';
import type { ModuleId, StageProfileCode } from '../src/lib/types';

// Prisma CLI 会自动读取 .env；`tsx prisma/seed.ts` 直跑时需要兜一层
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}

const prisma = new PrismaClient();

type Dimension = 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING' | 'GRAMMAR' | 'VOCAB' | 'SENTENCE';

interface AcceptanceSeed {
  dimension: Dimension;
  isRequired: boolean;
  criterionText: string;
}

const STAGE_SEEDS: {
  code: string;
  nameZh: string;
  estDaysMin: number;
  estDaysMax: number | null;
  sortOrder: number;
  status: 'ACTIVE' | 'NOT_STARTED';
  acceptance: AcceptanceSeed[];
}[] = [
  {
    code: 'S0_PREP',
    nameZh: '阶段零 · 准备与诊断（A0 前测区间）',
    estDaysMin: 1,
    estDaysMax: 2,
    sortOrder: 0,
    status: 'ACTIVE',
    acceptance: [
      {
        dimension: 'GRAMMAR',
        isRequired: true,
        criterionText:
          '用 Essential Grammar in Use 做 1–2 个单元的练习（先不看讲解），记录正确率与错误原因，确认当前起点。',
      },
      {
        dimension: 'LISTENING',
        isRequired: true,
        criterionText:
          '完成一段 A1/A2 短音频盲听（先不看文本），记录主题、能捕捉的关键信息以及听不出的片段。',
      },
      {
        dimension: 'READING',
        isRequired: true,
        criterionText: '完成一篇短阅读，记录生词数量与理解困难，作为阅读起点基线。',
      },
      {
        dimension: 'SPEAKING',
        isRequired: true,
        criterionText: '完成 1 分钟自我介绍录音，记录卡顿、重复与发音问题。',
      },
      {
        dimension: 'WRITING',
        isRequired: true,
        criterionText: '写出 5–8 个简单句并保留原稿，作为写作起点基线。',
      },
      {
        dimension: 'VOCAB',
        isRequired: false,
        criterionText: '选定唯一一个词汇工具（不每天更换），并确定每日新词量计划。',
      },
      {
        dimension: 'SENTENCE',
        isRequired: false,
        criterionText: '从基线材料中挑 3–5 句标出主语 S 与谓语 V。',
      },
    ],
  },
  {
    code: 'S1_A0_A2',
    nameZh: '阶段一 · 基础英语（A0→A2 训练区间）',
    estDaysMin: 120,
    estDaysMax: 180,
    sortOrder: 1,
    status: 'NOT_STARTED',
    acceptance: [
      {
        dimension: 'LISTENING',
        isRequired: true,
        criterionText:
          '对适级的 1–3 分钟短音频，不看文本能抓住主题和若干关键信息；至少连续 3 份材料都能完成主旨记录，再用文本核对。',
      },
      {
        dimension: 'READING',
        isRequired: true,
        criterionText:
          '能读适级短文或分级读物，理解主旨并回答大部分基本理解问题；不需要每个词都查。',
      },
      {
        dimension: 'SPEAKING',
        isRequired: true,
        criterionText:
          '能围绕自我介绍、工作/学习、日常安排、兴趣等熟悉话题说 2–3 分钟；可以犯错，但基本意思清楚。',
      },
      {
        dimension: 'WRITING',
        isRequired: true,
        criterionText:
          '能独立写约 80–120 词的简单短文/日记，句子基本完整，主要意思可理解。',
      },
      {
        dimension: 'GRAMMAR',
        isRequired: true,
        criterionText:
          'EGIU 的核心基础结构在练习中基本稳定；对常见错误能解释原因，且不会连续多次犯同一类错误。',
      },
      {
        dimension: 'VOCAB',
        isRequired: false,
        criterionText:
          '高频词的识别与理解逐渐稳定；1500–2500 个高频词可作参考目标，不作为唯一通关条件。',
      },
      {
        dimension: 'SENTENCE',
        isRequired: false,
        criterionText:
          '能标出句子的主语 S、谓语 V、宾语 O / 表语 C，并区分「句子成分」与「词性」两套概念。',
      },
    ],
  },
  {
    code: 'S2_A2_B1',
    nameZh: '阶段二 · 中级英语（A2→B1 训练区间）',
    estDaysMin: 90,
    estDaysMax: 120,
    sortOrder: 2,
    status: 'NOT_STARTED',
    acceptance: [
      {
        dimension: 'LISTENING',
        isRequired: true,
        criterionText: '能处理 3–5 分钟适级音频，概括主要内容并捕捉关键细节。',
      },
      {
        dimension: 'READING',
        isRequired: true,
        criterionText:
          '能阅读几百词的适级文章，区分主旨与细节，识别常见代词指代和逻辑连接。',
      },
      {
        dimension: 'SPEAKING',
        isRequired: true,
        criterionText:
          '能围绕熟悉话题表达约 5 分钟，给出观点、原因和例子，而不是只罗列单句。',
      },
      {
        dimension: 'WRITING',
        isRequired: true,
        criterionText: '能完成约 150–200 词的结构化短文，有清楚的段落和中心意思。',
      },
      {
        dimension: 'GRAMMAR',
        isRequired: true,
        criterionText:
          '能识别并分析基本句型及常见从句；中级语法不再只会做题，还能用于口头和书面表达。',
      },
      {
        dimension: 'VOCAB',
        isRequired: false,
        criterionText:
          '3000–4000 高频词可作参考范围；实际能听懂、读懂和主动使用的词比单纯背诵数量更重要。',
      },
      {
        dimension: 'SENTENCE',
        isRequired: false,
        criterionText:
          '能拆解五大基本句型与常见定语/状语从句：先框出主句主干，再分析从句与修饰成分。',
      },
    ],
  },
  {
    code: 'S3_B1_IELTS',
    nameZh: '阶段三 · 雅思应试（B1→IELTS 训练区间）',
    estDaysMin: 90,
    estDaysMax: 150,
    sortOrder: 3,
    status: 'NOT_STARTED',
    acceptance: [
      {
        dimension: 'LISTENING',
        isRequired: true,
        criterionText:
          '已熟悉听力题型、时间限制与评分维度；错题能区分词汇问题、定位问题、理解问题、注意力问题和策略问题。',
      },
      {
        dimension: 'READING',
        isRequired: true,
        criterionText:
          '已熟悉阅读题型与时间限制；错题能分类归因，并能用长难句主干分析定位答案。',
      },
      {
        dimension: 'SPEAKING',
        isRequired: true,
        criterionText:
          '口语练习有录音记录，能根据录音定位停顿、重复、语法和内容展开不足；按 Part 1/2/3 要求练习。',
      },
      {
        dimension: 'WRITING',
        isRequired: true,
        criterionText:
          '写作经过多轮修改，能回应题目、组织段落，并减少反复出现的基础语法错误。',
      },
      {
        dimension: 'GRAMMAR',
        isRequired: true,
        criterionText:
          '限时写作与口语中基础语法错误不再反复出现，并能依据反馈自我修正；至少完成 2 次有计时的分科练习或模考。',
      },
      {
        dimension: 'VOCAB',
        isRequired: false,
        criterionText:
          '话题词汇与高频词能主动使用；写作/口语中的词汇准确性经过外部或自我反馈修正。',
      },
      {
        dimension: 'SENTENCE',
        isRequired: false,
        criterionText:
          '真题阅读长难句能拆出主句主干与从句/修饰语，并把分析直接用于定位答案与理解论证。',
      },
    ],
  },
];

interface ResourceSeed {
  name: string;
  subject: string;
  type: string;
  applicableStages: string[];
  version?: string;
  totalUnits?: number;
  url?: string;
  note?: string;
  isPrimary: boolean;
}

const RESOURCE_SEEDS: ResourceSeed[] = [
  {
    name: 'Essential Grammar in Use',
    subject: 'GRAMMAR',
    type: 'BOOK',
    applicableStages: ['S1_A0_A2'],
    version: '4th edition',
    totalUnits: 115,
    note: 'SOP：先做练习再决定是否重学；三色诊断式复习，重点单元重学并造句。',
    isPrimary: true,
  },
  {
    name: 'English Grammar in Use',
    subject: 'GRAMMAR',
    type: 'BOOK',
    applicableStages: ['S2_A2_B1'],
    version: '5th edition',
    totalUnits: 145,
    note: 'SOP：通过 A2 阶段验收后再系统转入中级书，不要求机械抄完。',
    isPrimary: true,
  },
  {
    name: 'Oxford 3000 高频词表',
    subject: 'VOCAB',
    type: 'WORDLIST',
    applicableStages: ['S1_A0_A2', 'S2_A2_B1', 'S3_B1_IELTS'],
    totalUnits: 3000,
    note: 'SOP：每天 15–20 个新词，词要连同搭配、发音和例句记；旧词间隔复习。',
    isPrimary: true,
  },
  {
    name: 'English Pronunciation in Use Elementary',
    subject: 'PRONUNCIATION',
    type: 'BOOK',
    applicableStages: ['S1_A0_A2'],
    totalUnits: 50,
    note: 'SOP：每天 10–15 分钟，听音、模仿、录音对比，关注重音与句子节奏。',
    isPrimary: true,
  },
  {
    name: 'British Council LearnEnglish（A1/A2 听力）',
    subject: 'LISTENING',
    type: 'WEBSITE',
    applicableStages: ['S1_A0_A2'],
    url: 'https://learnenglish.britishcouncil.org/',
    note: 'SOP：先盲听抓主旨，第二遍抓信息，看文本定位听不清处，再听并复述。',
    isPrimary: true,
  },
  {
    name: 'Oxford Bookworms / Penguin Readers（分级读物）',
    subject: 'READING',
    type: 'GRADED_READER',
    applicableStages: ['S1_A0_A2', 'S2_A2_B1'],
    note: 'SOP：先读懂大意，仅查影响理解或反复出现的词，读后用 2–5 句总结。',
    isPrimary: true,
  },
  {
    name: 'Reading Explorer',
    subject: 'READING',
    type: 'BOOK',
    applicableStages: ['S2_A2_B1', 'S3_B1_IELTS'],
    note: '分级读物的升级补充材料；按能力而非日历升级难度。',
    isPrimary: false,
  },
  {
    name: 'Cambridge IELTS 真题（剑雅）',
    subject: 'EXAM',
    type: 'EXAM_PAPER',
    applicableStages: ['S3_B1_IELTS'],
    totalUnits: 18,
    note: 'SOP：以剑桥雅思真题或官方样题为主；每次练习都要复盘错因，不只对答案。',
    isPrimary: true,
  },
];

async function seedProfile(): Promise<void> {
  await prisma.userProfile.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      targetBandOverall: 6.5,
      targetBandListen: 6.5,
      targetBandRead: 6.5,
      targetBandWrite: 6.0,
      targetBandSpeak: 6.0,
      dailyMinutes: 240,
      timezone: 'Asia/Singapore',
      weeklyReviewDow: 0,
      aiEnabled: false,
      // v2.0 三目标全局默认
      cefrTarget: 'B2',
      mediatedSubject: 'French',
      mediatedStartBand: 'A2_B1',
    },
    update: {
      dailyMinutes: 240,
      timezone: 'Asia/Singapore',
      weeklyReviewDow: 0,
      // v2.0：只在用户没改过时回填默认，避免覆盖个人设置
      cefrTarget: 'B2',
      mediatedSubject: 'French',
      mediatedStartBand: 'A2_B1',
    },
  });
  console.log('✓ UserProfile（单用户配置 + v2 三目标默认）已就绪');
}

async function seedStages(): Promise<void> {
  const todayStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let acceptanceCount = 0;

  for (const stageSeed of STAGE_SEEDS) {
    const stage = await prisma.stage.upsert({
      where: { code: stageSeed.code },
      create: {
        code: stageSeed.code,
        nameZh: stageSeed.nameZh,
        estDaysMin: stageSeed.estDaysMin,
        estDaysMax: stageSeed.estDaysMax ?? null,
        sortOrder: stageSeed.sortOrder,
        status: stageSeed.status,
        startedAt: stageSeed.status === 'ACTIVE' ? todayStr : null,
      },
      update: {
        nameZh: stageSeed.nameZh,
        estDaysMin: stageSeed.estDaysMin,
        estDaysMax: stageSeed.estDaysMax ?? null,
        sortOrder: stageSeed.sortOrder,
      },
    });

    // 验收项是定义型子表：整组重建，保证与 SOP 原文一致
    await prisma.stageAcceptanceItem.deleteMany({ where: { stageId: stage.id } });
    await prisma.stageAcceptanceItem.createMany({
      data: stageSeed.acceptance.map((item, index) => ({
        stageId: stage.id,
        dimension: item.dimension,
        isRequired: item.isRequired,
        criterionText: item.criterionText,
        verdict: 'PENDING',
        sortOrder: index,
      })),
    });
    acceptanceCount += stageSeed.acceptance.length;
  }

  console.log(`✓ Stage 4 个阶段 + ${acceptanceCount} 条验收项已就绪`);
}

async function seedResources(): Promise<void> {
  let created = 0;
  let updated = 0;

  for (const resource of RESOURCE_SEEDS) {
    const existing = await prisma.resource.findFirst({ where: { name: resource.name } });
    const data = {
      name: resource.name,
      subject: resource.subject,
      type: resource.type,
      applicableStages: JSON.stringify(resource.applicableStages),
      version: resource.version ?? null,
      totalUnits: resource.totalUnits ?? null,
      url: resource.url ?? null,
      note: resource.note ?? null,
      isPrimary: resource.isPrimary,
    };

    if (existing) {
      await prisma.resource.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.resource.create({ data });
      created += 1;
    }
  }

  console.log(`✓ Resource 8 类初始资源已就绪（新增 ${created}，更新 ${updated}）`);
}

/**
 * v2.0 新增：四技能配比档案。
 *
 * 为 5 个 StageProfileCode 各初始化一条 default 配比记录（首次 seed 时生成，重复 seed 时跳过）。
 * 每条记录都是「定义型数据」，对应该阶段的标准配比，可供用户调用复制或参考。
 *
 * - PREPARATION: A0–A2 基准（30/30/25/15）
 * - A0_A2: 30/30/25/15
 * - A2_B1: 28/27/25/20
 * - B1_B2: 25/25/25/25
 * - IELTS_INTENSIVE: 无内置，需用户自行配置（故 seed 不创建）
 */
async function seedSkillAllocations(): Promise<void> {
  let created = 0;

  // IELTS_INTENSIVE 无内置配比（必须由用户按目标分数自行配置），因此不预置
  const seeded: StageProfileCode[] = STAGE_PROFILE_CODES.filter((p) => p !== 'IELTS_INTENSIVE');
  const todayStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const profileCode of seeded) {
    const allocation = STAGE_ALLOCATION[profileCode];

    const existing = await prisma.skillAllocationProfile.findFirst({
      where: { profileCode, isActive: true },
    });

    if (!existing) {
      await prisma.skillAllocationProfile.create({
        data: {
          profileCode,
          // IELTS 冲刺档属雅思轨道，其余均为通用英语轨道
          track: profileCode === 'IELTS_INTENSIVE' ? 'IELTS_PREPARATION' : 'GENERAL_ENGLISH',
          listeningPct: allocation.LISTENING,
          readingPct: allocation.READING,
          speakingPct: allocation.SPEAKING,
          writingPct: allocation.WRITING,
          effectiveFrom: todayStr,
          isActive: true,
          changeReason: '初始化默认配比档案',
        },
      });
      created += 1;
    }
  }

  console.log(`✓ SkillAllocationProfile 初始化完成（新增 ${created} 档）`);
}

/**
 * v2.0 新增：三条学习目标与里程碑骨架。
 *
 * 三条目标分别对应三个轨道，各自独立；里程碑框架可供后续执行时逐项回填。
 */
async function seedLearningGoals(): Promise<void> {
  let created = 0;

  for (const goalType of GOAL_TYPES) {
    const existing = await prisma.learningGoal.findUnique({
      where: { goalType },
    });

    if (!existing) {
      await prisma.learningGoal.create({
        data: {
          goalType,
          name: GOAL_TYPE_LABEL_ZH[goalType],
          targetValue: goalType === 'GENERAL_ENGLISH' ? 'B2' : undefined,
          status: 'ACTIVE',
          note: `${GOAL_TYPE_LABEL_ZH[goalType]} - 自动初始化目标`,
        },
      });
      created += 1;
    }
  }

  console.log(`✓ LearningGoal 三条目标已初始化（新增 ${created} 个）`);
}

/**
 * v2.0 新增：Stage.profileCode 回填。
 *
 * 现有 4 个 Stage 补充映射到 StageProfileCode（PREPARATION / A0_A2 / A2_B1 / B1_B2）。
 * 幂等：已有 profileCode 时跳过，仅在空值时更新。
 */
async function seedStageProfileCodes(): Promise<void> {
  let updated = 0;

  for (const [stageCode, profileCode] of Object.entries(STAGE_CODE_TO_PROFILE)) {
    const stage = await prisma.stage.findUnique({
      where: { code: stageCode },
    });

    if (stage && !stage.profileCode) {
      await prisma.stage.update({
        where: { id: stage.id },
        data: { profileCode },
      });
      updated += 1;
    }
  }

  console.log(`✓ Stage.profileCode 回填完成（更新 ${updated} 条）`);
}

/**
 * v2.0 新增：PlanTask.track / PlanTask.primarySkill 回填。
 *
 * 现有 PlanTask 的 module 字段推导出 track 与 primarySkill 属性（如已有值则跳过）。
 * 通过 MODULE_TRACK 与 MODULE_TO_PRIMARY 常量进行映射。
 */
async function seedPlanTaskAttributes(): Promise<void> {
  const tasks = await prisma.planTask.findMany({
    where: {
      OR: [
        { track: 'GENERAL_ENGLISH' }, // 当前默认值，视为「待完整化」
        { primarySkill: 'FOUNDATION' }, // 当前默认值
      ],
    },
  });

  let updated = 0;

  for (const task of tasks) {
    const module = task.module as ModuleId;
    const newTrack = MODULE_TRACK[module] ?? 'GENERAL_ENGLISH';
    const newSkill = MODULE_TO_PRIMARY[module] ?? 'FOUNDATION';

    if (task.track !== newTrack || task.primarySkill !== newSkill) {
      await prisma.planTask.update({
        where: { id: task.id },
        data: {
          track: newTrack,
          primarySkill: newSkill,
        },
      });
      updated += 1;
    }
  }

  console.log(`✓ PlanTask 属性（track/skill）回填完成（更新 ${updated} 条）`);
}

/**
 * v2.0 新增：里程碑骨架初始化。
 *
 * 为三条 LearningGoal 各创建若干里程碑占位符（里程碑代码 + 标题已预设，待执行时填 status）。
 * 这里仅创建骨架，真实的 achieved / failed 状态由实际学习过程决定。
 */
async function seedGoalMilestones(): Promise<void> {
  let created = 0;

  // 通用英语轨道里程碑
  const geGoal = await prisma.learningGoal.findUnique({
    where: { goalType: 'GENERAL_ENGLISH' },
  });
  if (geGoal) {
    const geMilestones = [
      { code: 'GE_A1_EXIT', title: 'A1 达成（基础识别）' },
      { code: 'GE_A2_EXIT', title: 'A2 达成（基础应用）' },
      { code: 'GE_B1_EXIT', title: 'B1 达成（中级独立）' },
      { code: 'GE_B2_EXIT', title: 'B2 达成（高级沟通）' },
    ];
    for (const milestone of geMilestones) {
      const existing = await prisma.goalMilestone.findUnique({
        where: { goalId_milestoneCode: { goalId: geGoal.id, milestoneCode: milestone.code } },
      });
      if (!existing) {
        await prisma.goalMilestone.create({
          data: {
            goalId: geGoal.id,
            milestoneCode: milestone.code,
            title: milestone.title,
            status: 'PENDING',
            sortOrder: geMilestones.indexOf(milestone),
          },
        });
        created += 1;
      }
    }
  }

  // IELTS 轨道里程碑
  const ieltsGoal = await prisma.learningGoal.findUnique({
    where: { goalType: 'IELTS' },
  });
  if (ieltsGoal) {
    const ieltsMilestones = [
      { code: 'IELTS_BAND_6_0', title: 'IELTS 6.0 达成（雅思中级）' },
      { code: 'IELTS_BAND_6_5', title: 'IELTS 6.5 达成（雅思中高级）' },
      { code: 'IELTS_BAND_7_0', title: 'IELTS 7.0 达成（雅思良好）' },
    ];
    for (const milestone of ieltsMilestones) {
      const existing = await prisma.goalMilestone.findUnique({
        where: { goalId_milestoneCode: { goalId: ieltsGoal.id, milestoneCode: milestone.code } },
      });
      if (!existing) {
        await prisma.goalMilestone.create({
          data: {
            goalId: ieltsGoal.id,
            milestoneCode: milestone.code,
            title: milestone.title,
            status: 'PENDING',
            sortOrder: ieltsMilestones.indexOf(milestone),
          },
        });
        created += 1;
      }
    }
  }

  // 英语媒介学习轨道里程碑
  const mediatedGoal = await prisma.learningGoal.findUnique({
    where: { goalType: 'ENGLISH_MEDIATED_LEARNING' },
  });
  if (mediatedGoal) {
    const mediatedMilestones = [
      { code: 'MEDIATED_TRIAL_START', title: '媒介学习试学开始（A2–B1）' },
      { code: 'MEDIATED_TRIAL_COMPLETE', title: '试学完成，进入系统学习' },
      { code: 'MEDIATED_SYSTEMATIC_PHASE', title: '系统化学习（B1 后）' },
    ];
    for (const milestone of mediatedMilestones) {
      const existing = await prisma.goalMilestone.findUnique({
        where: { goalId_milestoneCode: { goalId: mediatedGoal.id, milestoneCode: milestone.code } },
      });
      if (!existing) {
        await prisma.goalMilestone.create({
          data: {
            goalId: mediatedGoal.id,
            milestoneCode: milestone.code,
            title: milestone.title,
            status: 'PENDING',
            sortOrder: mediatedMilestones.indexOf(milestone),
          },
        });
        created += 1;
      }
    }
  }

  console.log(`✓ GoalMilestone 里程碑骨架完成（新增 ${created} 个）`);
}

/**
 * v2.6：材料导入用的固定词汇来源行。
 *
 * 为什么要 seed：ADR-07 规定「材料词汇入主库」时 `sourceId` 必须指向
 * `VocabularySource(sourceType='MATERIAL')` 的固定行；缺失时 T12 会按需创建一次，
 * 但提前 seed 可以让「来源归属」在第一次同步前就存在，避免多写一条分支。
 * 用固定 id + upsert，因此反复执行不会产生第二行。
 */
async function seedMaterialVocabularySource(): Promise<void> {
  const existing = await prisma.vocabularySource.findUnique({ where: { id: 'vsource-material' } });
  if (existing) return;
  await prisma.vocabularySource.create({
    data: {
      id: 'vsource-material',
      sourceType: 'MATERIAL',
      title: '材料导入',
      notes: 'v2.6 Smart Learning Materials：从学习材料提取并确认的词汇候选统一归到此来源。',
    },
  });
  console.log('✓ VocabularySource(MATERIAL) 已创建');
}

async function main(): Promise<void> {
  console.log('开始写入种子数据…');
  await seedProfile();
  await seedStages();
  await seedResources();
  // ── v2.0 增量回填（全部幂等，可反复执行）──
  await seedSkillAllocations();
  await seedLearningGoals();
  await seedStageProfileCodes();
  await seedPlanTaskAttributes();
  await seedGoalMilestones();
  // ── v2.6 增量（幂等）──
  await seedMaterialVocabularySource();
  console.log('完成。注意：本 seed 不写入任何学习记录/错题/词汇假数据。');
}

main()
  .catch((error: unknown) => {
    console.error('种子数据写入失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
