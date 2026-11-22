/**
 * 诊断蓝图与题库（v2.4.1）。
 *
 * 原则：
 * 1. 题库是版本化主数据，代码内种子 + 幂等 upsert 写库，不在运行时让 LLM 现编题。
 * 2. 客观题必须有可验证标准答案；开放任务必须有版本化 rubric。
 * 3. 只有 `VERIFIED` / `RUBRIC` 可参与定级；`AI_PRACTICE` 仅用于练习（本版不播种）。
 */

import type { PrismaClient } from '@prisma/client';
import {
  DIAGNOSTIC_BLUEPRINT_CODE,
  DIAGNOSTIC_BLUEPRINT_VERSION,
  type DiagnosticSkill,
  type DiagSourceType,
  type DiagTaskType,
  type DiagLevel,
} from './constants';

export interface ItemOption {
  key: 'A' | 'B' | 'C' | 'D';
  text: string;
}

export interface RubricDimensionSeed {
  id: string;
  labelZh: string;
  descriptor: string;
}

export interface DiagnosticItemSeed {
  itemCode: string;
  skill: DiagnosticSkill;
  subskill: string;
  targetLevelMin: DiagLevel;
  targetLevelMax: DiagLevel;
  difficulty: 1 | 2 | 3 | 4;
  taskType: DiagTaskType;
  sourceType: DiagSourceType;
  prompt: string;
  passage?: string;
  transcript?: string;
  options?: ItemOption[];
  correctAnswer?: string;
  answerExplanation?: string;
  rubric?: { version: string; dimensions: RubricDimensionSeed[] };
  sortOrder: number;
}

const MCQ_RUBRIC_NOTE = '客观题按题库标准答案确定性判分；答错只说明该题所测能力点未达标，不外推为整体等级。';

const SPEAKING_RUBRIC: RubricDimensionSeed[] = [
  { id: 'fluency', labelZh: '流利与连续', descriptor: '能持续表达，停顿不影响理解' },
  { id: 'vocabulary', labelZh: '词汇范围', descriptor: '能调用足够词汇表达目标内容' },
  { id: 'grammar', labelZh: '语法范围与准确性', descriptor: '基本句型可理解，错误不阻断交流' },
  { id: 'intelligibility', labelZh: '可理解度', descriptor: '听者能理解主要意思（不以母语口音为目标）' },
  { id: 'coherence', labelZh: '连贯性', descriptor: '内容有基本顺序与连接' },
  { id: 'interaction', labelZh: '互动与回应相关性', descriptor: '回应切题，必要时能澄清或修补' },
];

const WRITING_RUBRIC: RubricDimensionSeed[] = [
  { id: 'task', labelZh: '任务完成度', descriptor: '回应题目要求，内容切题' },
  { id: 'grammar', labelZh: '语法范围与准确性', descriptor: '句型可理解，错误不造成严重误解' },
  { id: 'lexical', labelZh: '词汇资源', descriptor: '用词能表达目标意思' },
  { id: 'coherence', labelZh: '连贯与衔接', descriptor: '段落与句子之间有逻辑连接' },
  { id: 'spelling', labelZh: '拼写与标点', descriptor: '拼写和标点基本可读' },
];

const EMLR_RUBRIC: RubricDimensionSeed[] = [
  { id: 'comprehension', labelZh: '英文讲解理解', descriptor: '能提取英文教学材料中的关键规则' },
  { id: 'terminology', labelZh: '术语掌握', descriptor: '能正确使用材料中的术语' },
  { id: 'application', labelZh: '规则应用', descriptor: '能把规则应用到新的例子' },
];

function mcq(
  seed: Omit<DiagnosticItemSeed, 'taskType' | 'sourceType' | 'options' | 'correctAnswer' | 'answerExplanation'> & {
    options: ItemOption[];
    correctAnswer: string;
    answerExplanation: string;
  },
): DiagnosticItemSeed {
  return {
    ...seed,
    taskType: 'MCQ',
    sourceType: 'VERIFIED',
    answerExplanation: `${seed.answerExplanation}\n\n判分说明：${MCQ_RUBRIC_NOTE}`,
  };
}

export const DIAGNOSTIC_ITEM_SEEDS: DiagnosticItemSeed[] = [
  // ── Listening ────────────────────────────────────────────────
  mcq({
    itemCode: 'L-KEY-A1',
    skill: 'LISTENING',
    subskill: 'key_information',
    targetLevelMin: 'Pre-A1',
    targetLevelMax: 'A1',
    difficulty: 1,
    prompt: '听录音，选择图书馆几点关门。',
    transcript: 'The library closes at six.',
    options: [
      { key: 'A', text: '5 点' },
      { key: 'B', text: '6 点' },
      { key: 'C', text: '7 点' },
      { key: 'D', text: '8 点' },
    ],
    correctAnswer: 'B',
    answerExplanation: '录音原句为「closes at six」，对应 B。',
    sortOrder: 10,
  }),
  mcq({
    itemCode: 'L-DETAIL-A2',
    skill: 'LISTENING',
    subskill: 'detail_understanding',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    prompt: '听对话，选择会议改到哪个地点。',
    transcript:
      "Hi, I'm calling about the meeting. It's moved from Room 204 to the main hall at 3 p.m.",
    options: [
      { key: 'A', text: 'Room 204' },
      { key: 'B', text: 'main hall' },
      { key: 'C', text: 'library' },
      { key: 'D', text: '3 p.m.' },
    ],
    correctAnswer: 'B',
    answerExplanation: '地点从 Room 204 改到 main hall；3 p.m. 是时间，不是地点。',
    sortOrder: 20,
  }),
  mcq({
    itemCode: 'L-GIST-B1',
    skill: 'LISTENING',
    subskill: 'gist_understanding',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    prompt: '听公告，选择说话人的主要目的。',
    transcript:
      "Starting next Monday, the city's bike-sharing service will require users to lock bikes at designated stations. Bikes left outside these stations will cost an extra two dollars. The city says the change aims to reduce clutter on sidewalks and improve safety.",
    options: [
      { key: 'A', text: 'Introduce a fee for every user' },
      { key: 'B', text: 'Explain a new rule and its purpose' },
      { key: 'C', text: 'Announce a price cut' },
      { key: 'D', text: 'Close the bike-sharing service' },
    ],
    correctAnswer: 'B',
    answerExplanation: '公告说明新规（必须停在指定站点）及其目的（减少人行道杂乱、提高安全）。',
    sortOrder: 30,
  }),
  mcq({
    itemCode: 'L-INFER-B2',
    skill: 'LISTENING',
    subskill: 'inference',
    targetLevelMin: 'B1',
    targetLevelMax: 'B2',
    difficulty: 4,
    prompt: '听短讲，选择说话人暗示的内容。',
    transcript:
      'I know the brochure says the course starts in September, but the department has been struggling to find a lecturer. Unless someone is appointed by the end of this month, we should probably tell applicants to prepare for a delay.',
    options: [
      { key: 'A', text: '课程会提前开始' },
      { key: 'B', text: '课程可能推迟' },
      { key: 'C', text: '宣传册完全准确' },
      { key: 'D', text: '讲师已经到位' },
    ],
    correctAnswer: 'B',
    answerExplanation: '「prepare for a delay」直接暗示可能推迟；其余选项与原文相反。',
    sortOrder: 40,
  }),

  // ── Reading ─────────────────────────────────────────────────
  mcq({
    itemCode: 'R-SIGN-A1',
    skill: 'READING',
    subskill: 'word_recognition',
    targetLevelMin: 'Pre-A1',
    targetLevelMax: 'A1',
    difficulty: 1,
    prompt: '读标识，选择不被允许的行为。',
    passage: 'No food or drink in the computer room.',
    options: [
      { key: 'A', text: '在机房吃食物或喝饮料' },
      { key: 'B', text: '在机房使用电脑' },
      { key: 'C', text: '在机房阅读' },
      { key: 'D', text: '在机房提问' },
    ],
    correctAnswer: 'A',
    answerExplanation: '「No food or drink」禁止食物和饮料。',
    sortOrder: 110,
  }),
  mcq({
    itemCode: 'R-DETAIL-A2',
    skill: 'READING',
    subskill: 'locating_details',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    prompt: '读邮件，选择写信人建议的会议时间。',
    passage:
      "Hi Sam, I can't make our Tuesday meeting because I'm travelling to Manchester. Could we move it to Thursday at 10 a.m.? I've booked Meeting Room 2.",
    options: [
      { key: 'A', text: 'Tuesday' },
      { key: 'B', text: 'Thursday at 10 a.m.' },
      { key: 'C', text: 'Manchester' },
      { key: 'D', text: 'Meeting Room 2' },
    ],
    correctAnswer: 'B',
    answerExplanation: '「move it to Thursday at 10 a.m.」是建议的新时间。',
    sortOrder: 120,
  }),
  mcq({
    itemCode: 'R-GIST-B1',
    skill: 'READING',
    subskill: 'gist_understanding',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    prompt: '读段落，选择主旨。',
    passage:
      'Community gardens were once seen mainly as a way to grow cheap vegetables. Today, however, many cities promote them for a different reason: they bring neighbours together and give children a first-hand understanding of where food comes from. Critics point out that the plots are often too small to feed a family, but supporters argue that the social benefits matter more than the harvest.',
    options: [
      { key: 'A', text: '社区菜园主要用于生产廉价蔬菜' },
      { key: 'B', text: '社区菜园的价值越来越体现在社会效益上' },
      { key: 'C', text: '社区菜园已经无法在城市生存' },
      { key: 'D', text: '所有家庭都能靠社区菜园自给自足' },
    ],
    correctAnswer: 'B',
    answerExplanation: '转折后作者强调社区与社会理解等社会效益，支持者认为社会收益比收成更重要。',
    sortOrder: 130,
  }),
  mcq({
    itemCode: 'R-REFERENCE-B2',
    skill: 'READING',
    subskill: 'reference_and_cohesion',
    targetLevelMin: 'B1',
    targetLevelMax: 'B2',
    difficulty: 4,
    prompt: '读段落，判断「this reluctance」指什么。',
    passage:
      'The committee first proposed the new roster in March. Several members worried that flexible shifts would disrupt family life, and they resisted the proposal for weeks. This reluctance, however, was short-lived: once a trial period was agreed, most objections disappeared.',
    options: [
      { key: 'A', text: '委员会最初提出新排班表的动作' },
      { key: 'B', text: '部分成员对新排班表持续数周的抵触' },
      { key: 'C', text: '试运行期间的安排' },
      { key: 'D', text: '家庭生活受到的影响' },
    ],
    correctAnswer: 'B',
    answerExplanation: '「reluctance」回指前句「they resisted the proposal for weeks」。',
    sortOrder: 140,
  }),

  // ── Grammar ─────────────────────────────────────────────────
  mcq({
    itemCode: 'G-BE-A1',
    skill: 'GRAMMAR',
    subskill: 'be_verbs',
    targetLevelMin: 'Pre-A1',
    targetLevelMax: 'A1',
    difficulty: 1,
    prompt: '选择正确的 be 动词：My brother ___ a teacher.',
    options: [
      { key: 'A', text: 'is' },
      { key: 'B', text: 'are' },
      { key: 'C', text: 'am' },
      { key: 'D', text: 'be' },
    ],
    correctAnswer: 'A',
    answerExplanation: '主语 My brother 是第三人称单数，用 is。',
    sortOrder: 210,
  }),
  mcq({
    itemCode: 'G-PERFECT-A2',
    skill: 'GRAMMAR',
    subskill: 'present_perfect',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    prompt: '选择正确形式：She ___ in Singapore since 2019.',
    options: [
      { key: 'A', text: 'lives' },
      { key: 'B', text: 'lived' },
      { key: 'C', text: 'has lived' },
      { key: 'D', text: 'is living' },
    ],
    correctAnswer: 'C',
    answerExplanation: 'since 2019 表示从过去持续到现在，用现在完成时 has lived。',
    sortOrder: 220,
  }),
  mcq({
    itemCode: 'G-RELATIVE-B1',
    skill: 'GRAMMAR',
    subskill: 'relative_clauses',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    prompt: '选择正确的引导词：The book ___ you lent me was fascinating.',
    options: [
      { key: 'A', text: 'who' },
      { key: 'B', text: 'which' },
      { key: 'C', text: 'whose' },
      { key: 'D', text: 'where' },
    ],
    correctAnswer: 'B',
    answerExplanation: '先行词 book 是物，在从句中作宾语，用 which。',
    sortOrder: 230,
  }),
  mcq({
    itemCode: 'G-CONDITIONAL-B2',
    skill: 'GRAMMAR',
    subskill: 'conditionals',
    targetLevelMin: 'B1',
    targetLevelMax: 'B2',
    difficulty: 4,
    prompt: '选择正确形式：___ more carefully, he would not have made that mistake.',
    options: [
      { key: 'A', text: 'If he drives' },
      { key: 'B', text: 'Had he driven' },
      { key: 'C', text: 'He had driven' },
      { key: 'D', text: 'Driving' },
    ],
    correctAnswer: 'B',
    answerExplanation: '与过去事实相反的虚拟条件句可倒装为 Had he driven（= If he had driven）。',
    sortOrder: 240,
  }),

  // ── Vocabulary ──────────────────────────────────────────────
  mcq({
    itemCode: 'V-CONTEXT-A2',
    skill: 'VOCABULARY',
    subskill: 'meaning_in_context',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    prompt: '选择最合适的词：The instructions were so ___ that everyone understood them immediately.',
    options: [
      { key: 'A', text: 'vague' },
      { key: 'B', text: 'clear' },
      { key: 'C', text: 'complex' },
      { key: 'D', text: 'rare' },
    ],
    correctAnswer: 'B',
    answerExplanation: 'everyone understood them immediately 对应 clear。',
    sortOrder: 310,
  }),
  mcq({
    itemCode: 'V-COLLOC-B1',
    skill: 'VOCABULARY',
    subskill: 'collocation',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    prompt: '选择正确搭配：We need to ___ a decision by Friday.',
    options: [
      { key: 'A', text: 'do' },
      { key: 'B', text: 'make' },
      { key: 'C', text: 'take' },
      { key: 'D', text: 'give' },
    ],
    correctAnswer: 'B',
    answerExplanation: '英语固定搭配为 make a decision。',
    sortOrder: 320,
  }),
  {
    itemCode: 'V-FORM-B1',
    skill: 'VOCABULARY',
    subskill: 'form_recall',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    taskType: 'SHORT_ANSWER',
    sourceType: 'VERIFIED',
    prompt: '填空（用括号内词的正确形式）：The company\'s ___ (grow) has been rapid this year.',
    correctAnswer: 'growth',
    answerExplanation: '空格需要名词，grow 的名词形式是 growth。判分时忽略大小写与首尾空格。',
    sortOrder: 330,
  },

  // ── Sentence Structure ──────────────────────────────────────
  mcq({
    itemCode: 'S-MAIN-A2',
    skill: 'SENTENCE_STRUCTURE',
    subskill: 'main_clause',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    prompt: '选择句子的主句（主干）。',
    passage: 'In the morning, after a quick breakfast, my sister usually walks to school.',
    options: [
      { key: 'A', text: 'In the morning' },
      { key: 'B', text: 'after a quick breakfast' },
      { key: 'C', text: 'my sister usually walks to school' },
      { key: 'D', text: 'a quick breakfast' },
    ],
    correctAnswer: 'C',
    answerExplanation: '前两个是状语，主句为 my sister usually walks to school。',
    sortOrder: 410,
  }),
  mcq({
    itemCode: 'S-COMPLEX-B2',
    skill: 'SENTENCE_STRUCTURE',
    subskill: 'complex_sentence_head',
    targetLevelMin: 'B1',
    targetLevelMax: 'B2',
    difficulty: 4,
    prompt: '选择整句的主句谓语动词。',
    passage:
      'The report that the committee published last week argues that remote work reduces commuting costs.',
    options: [
      { key: 'A', text: 'published' },
      { key: 'B', text: 'argues' },
      { key: 'C', text: 'reduces' },
      { key: 'D', text: 'work' },
    ],
    correctAnswer: 'B',
    answerExplanation: '主语是 The report，主句谓语是 argues；published 是定语从句谓语，reduces 是宾语从句谓语。',
    sortOrder: 420,
  }),

  // ── Speaking（rubric） ──────────────────────────────────────
  {
    itemCode: 'SP-PROD-A2',
    skill: 'SPEAKING',
    subskill: 'spoken_production',
    targetLevelMin: 'A1',
    targetLevelMax: 'A2',
    difficulty: 2,
    taskType: 'OPEN_TASK',
    sourceType: 'RUBRIC',
    prompt:
      '用英语连续说 45–60 秒：描述你平常的一天（morning / afternoon / evening）。准备 30 秒，不写稿。录音可选；若录音失败请标记「技术无效」，不要勉强提交。',
    rubric: { version: 'sp.v1', dimensions: SPEAKING_RUBRIC },
    sortOrder: 510,
  },
  {
    itemCode: 'SP-INT-B1',
    skill: 'SPEAKING',
    subskill: 'spoken_interaction',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    taskType: 'OPEN_TASK',
    sourceType: 'RUBRIC',
    prompt:
      '用英语依次回答三个追问（每问 20–30 秒）：1) Why do you do these activities? 2) What would you change about your day? 3) If you had one extra hour, how would you use it? 可以用文字写下你要说的要点，但不要照读整段稿子。',
    rubric: { version: 'sp.v1', dimensions: SPEAKING_RUBRIC },
    sortOrder: 520,
  },

  // ── Writing（rubric） ───────────────────────────────────────
  {
    itemCode: 'WR-DESC-A2',
    skill: 'WRITING',
    subskill: 'descriptive_writing',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 2,
    taskType: 'OPEN_TASK',
    sourceType: 'RUBRIC',
    prompt:
      'Write 80–120 words describing a place you know well (a park, a café, or a street). Say where it is, what you can see and do there, and why you like or dislike it. 独立写作，不使用翻译或 AI；写完后不要自行修改原稿，系统只评第一版。',
    rubric: { version: 'wr.v1', dimensions: WRITING_RUBRIC },
    sortOrder: 610,
  },

  // ── EMLR（可选） ────────────────────────────────────────────
  {
    itemCode: 'EMLR-APPLY-B1',
    skill: 'EMLR',
    subskill: 'rule_transfer',
    targetLevelMin: 'A2',
    targetLevelMax: 'B1',
    difficulty: 3,
    taskType: 'OPEN_TASK',
    sourceType: 'RUBRIC',
    prompt:
      '阅读下面的英文解释，用中文或英文回答：1) 用自己的话解释 opportunity cost；2) 给一个你自己的例子。作答不是 CEFR 等级证据，只用于内部「英语媒介学习准备度」画像。',
    passage:
      'Opportunity cost is the value of the next best alternative you give up when you make a choice. For example, if you spend an evening studying English, the opportunity cost might be the rest or the time with friends you could have had instead.',
    rubric: { version: 'emlr.v1', dimensions: EMLR_RUBRIC },
    sortOrder: 710,
  },
];

/** 纯函数：种子自检（供单测与启动前检查使用）。 */
export function validateBankSeeds(
  seeds: DiagnosticItemSeed[] = DIAGNOSTIC_ITEM_SEEDS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (seen.has(seed.itemCode)) problems.push(`重复 itemCode：${seed.itemCode}`);
    seen.add(seed.itemCode);
    if (seed.taskType === 'MCQ' || seed.taskType === 'SHORT_ANSWER') {
      if (!seed.correctAnswer?.trim()) problems.push(`${seed.itemCode} 缺少标准答案`);
      if (seed.taskType === 'MCQ') {
        if (!seed.options || seed.options.length < 2) problems.push(`${seed.itemCode} 选项不足`);
        else if (!seed.options.some((option) => option.key === seed.correctAnswer)) {
          problems.push(`${seed.itemCode} 标准答案不在选项中`);
        }
      }
    }
    if (seed.taskType === 'OPEN_TASK') {
      if (seed.sourceType !== 'RUBRIC') problems.push(`${seed.itemCode} 开放任务必须使用 rubric`);
      if (!seed.rubric || seed.rubric.dimensions.length === 0) {
        problems.push(`${seed.itemCode} 缺少评分规准`);
      }
    }
    if (seed.difficulty < 1 || seed.difficulty > 4) problems.push(`${seed.itemCode} 难度越界`);
  }
  return problems;
}

/** 幂等初始化蓝图与题库；已存在题目只更新内容，保留曝光计数。 */
export async function ensureDiagnosticBank(prisma: PrismaClient): Promise<{ blueprintId: string }> {
  const problems = validateBankSeeds();
  if (problems.length > 0) {
    throw new Error(`诊断题库种子不合法：${problems.join('；')}`);
  }

  const blueprint = await prisma.diagnosticBlueprint.upsert({
    where: { code: DIAGNOSTIC_BLUEPRINT_CODE },
    create: {
      id: 'diag-bp-core',
      code: DIAGNOSTIC_BLUEPRINT_CODE,
      version: DIAGNOSTIC_BLUEPRINT_VERSION,
      title: 'v2.4.1 初始能力诊断（Pre-A1–B2 抽样）',
      description:
        '四项核心技能 + 三项辅助能力抽样；不是官方 CEFR 认证，覆盖不足处会明确标注。',
      active: true,
    },
    update: {
      version: DIAGNOSTIC_BLUEPRINT_VERSION,
      title: 'v2.4.1 初始能力诊断（Pre-A1–B2 抽样）',
      active: true,
    },
  });

  for (const seed of DIAGNOSTIC_ITEM_SEEDS) {
    const data = {
      blueprintId: blueprint.id,
      skill: seed.skill,
      subskill: seed.subskill,
      targetLevelMin: seed.targetLevelMin,
      targetLevelMax: seed.targetLevelMax,
      difficulty: seed.difficulty,
      taskType: seed.taskType,
      sourceType: seed.sourceType,
      prompt: seed.prompt,
      passage: seed.passage ?? null,
      transcript: seed.transcript ?? null,
      optionsJson: seed.options ? JSON.stringify(seed.options) : null,
      correctAnswer: seed.correctAnswer ?? null,
      answerExplanation: seed.answerExplanation ?? null,
      rubricJson: seed.rubric ? JSON.stringify(seed.rubric) : null,
      rubricVersion: seed.rubric?.version ?? 'v1',
      validationStatus: seed.sourceType === 'VERIFIED' ? 'VERIFIED' : 'RUBRIC_APPROVED',
      active: true,
      sortOrder: seed.sortOrder,
    };
    await prisma.diagnosticItem.upsert({
      where: { itemCode: seed.itemCode },
      create: {
        id: `diag-item-${seed.itemCode.toLowerCase()}`,
        itemCode: seed.itemCode,
        ...data,
      },
      update: data,
    });
  }

  return { blueprintId: blueprint.id };
}

/** 会话初始题目：每个技能基础题；口语两个子维度都测，EMLR 可选。 */
export function pickInitialItemCodes(includeEmlr: boolean): string[] {
  const codes = [
    'L-DETAIL-A2',
    'R-DETAIL-A2',
    'G-PERFECT-A2',
    'V-CONTEXT-A2',
    'S-MAIN-A2',
    'SP-PROD-A2',
    'SP-INT-B1',
    'WR-DESC-A2',
  ];
  if (includeEmlr) codes.push('EMLR-APPLY-B1');
  return codes;
}