/**
 * 三目标卡聚合查询（Dashboard 顶部）。
 *
 * 核心约束（SOP v2 §2 / 需求「三种目标分别统计和验收」）：
 *   **三条轨道分别计算，绝不合成为一个「总能力分」。**
 *   本模块返回三个独立的 `GoalCardDto`，每个都带自己的 `basis`
 *   （「凭什么这么判断」），让用户能核对结论来源。
 *
 * 成绩独立性（结构保证）：
 *   - General English 只读 `SkillAssessment`（CEFR 评估）；
 *   - IELTS 只读 `IeltsAssessment`（正式/模考成绩）；
 *   - English-mediated 只读 `EnglishMediatedSession`。
 *   三者之间没有任何换算表 —— 这是刻意的，需求明确禁止互相替代。
 *
 * 证据不足一律 `progress: null`（展示「证据不足」），绝不补 0 冒充「毫无进展」。
 */

import { CEFR_LEVELS, GOAL_HREF, GOAL_TYPE_LABEL_ZH, MEDIATED_INTENSITY_BY_PROFILE } from '@/lib/constants';
import { resolveBusinessDate } from '@/lib/businessTime';
import { skillShare } from '@/lib/domain/allocation';
import { evaluateGeneralEnglishGate, evaluateIeltsGate, evaluateMediatedGate, goalProgress, mediatedOutputCount } from '@/lib/domain/tracks';
import { prisma } from '@/lib/prisma';
import type { CefrLevel, GoalCardDto, LearningTrack, MediatedIntensity, StageProfileCode } from '@/lib/types';

const TRACKS: LearningTrack[] = ['GENERAL_ENGLISH', 'IELTS_PREPARATION', 'ENGLISH_MEDIATED_LEARNING'];

/** 当前阶段（ACTIVE 或最近一次）的 profileCode，用于决定媒介学习强度档。 */
async function currentProfileCode(): Promise<StageProfileCode | null> {
  const stage = await prisma.stage.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { sortOrder: 'desc' },
    select: { profileCode: true },
  });
  return (stage?.profileCode as StageProfileCode) ?? null;
}

/**
 * 三目标卡。
 *
 * @param nowDate 业务日（测试可注入）
 */
export async function getGoalCards(nowDateParam?: string): Promise<GoalCardDto[]> {
  const nowDate = await resolveBusinessDate(nowDateParam);
  const profile = await prisma.userProfile.findUnique({ where: { id: 1 } });
  const cefrTarget = (profile?.cefrTarget ?? 'B2') as CefrLevel;
  const mediatedSubject = profile?.mediatedSubject ?? 'French';

  const [geGoal, ieltsGoal, medGoal, profileCode] = await Promise.all([
    prisma.learningGoal.findUnique({ where: { goalType: 'GENERAL_ENGLISH' }, include: { milestones: true } }),
    prisma.learningGoal.findUnique({ where: { goalType: 'IELTS' }, include: { milestones: true } }),
    prisma.learningGoal.findUnique({
      where: { goalType: 'ENGLISH_MEDIATED_LEARNING' },
      include: { milestones: true },
    }),
    currentProfileCode(),
  ]);

  // ── 通用英语：只看 CEFR 评估 ──
  const assessments = await prisma.skillAssessment.findMany({
    orderBy: { assessDate: 'asc' },
    select: { skill: true, cefrLevel: true, assessDate: true, confidence: true },
  });

  const geTotalMinutes = await prisma.studySessionDaySplit
    .aggregate({ where: { session: { track: 'GENERAL_ENGLISH' } }, _sum: { minutes: true } })
    .then((r) => r._sum.minutes ?? 0);

  const geGate = evaluateGeneralEnglishGate({
    assessments: assessments.map((a) => ({
      skill: a.skill,
      cefrLevel: a.cefrLevel,
      assessDate: a.assessDate,
      confidence: a.confidence,
    })),
    targetLevel: cefrTarget,
    totalMinutes: geTotalMinutes,
  });

  // 当前等级 = 四项最近评估里最低的那个（木桶原理：短板才算真实水平）
  const latestBySkill = new Map<string, string>();
  for (const a of assessments) latestBySkill.set(a.skill, a.cefrLevel);
  const fourSkills = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'];
  const assessedLevels = fourSkills.map((s) => latestBySkill.get(s)).filter((v): v is string => Boolean(v));
  const lowestLevel = assessedLevels.length
    ? CEFR_LEVELS.filter((l) => assessedLevels.includes(l)).pop() ?? null
    : null;

  const geMilestones = geGoal?.milestones ?? [];
  const geAchieved = geMilestones.filter((m) => m.status === 'ACHIEVED').length;

  // ── IELTS：只看正式/模考成绩 ──
  const ieltsRecords = await prisma.ieltsAssessment.findMany({
    orderBy: { testDate: 'desc' },
    select: {
      testDate: true,
      testType: true,
      overallBand: true,
      listeningBand: true,
      readingBand: true,
      writingBand: true,
      speakingBand: true,
    },
  });

  const ieltsTarget = {
    overall: ieltsGoal?.targetValue ? Number(ieltsGoal.targetValue) || (profile?.targetBandOverall ?? 6.5) : (profile?.targetBandOverall ?? 6.5),
    listening: ieltsGoal?.minListening ?? profile?.targetBandListen ?? null,
    reading: ieltsGoal?.minReading ?? profile?.targetBandRead ?? null,
    writing: ieltsGoal?.minWriting ?? profile?.targetBandWrite ?? null,
    speaking: ieltsGoal?.minSpeaking ?? profile?.targetBandSpeak ?? null,
  };

  const ieltsGate = evaluateIeltsGate({ records: ieltsRecords, target: ieltsTarget });
  const latestIelts = ieltsRecords.find((r) => r.testType === 'OFFICIAL' || r.testType === 'MOCK') ?? null;
  const ieltsMilestones = ieltsGoal?.milestones ?? [];
  const ieltsAchieved = ieltsMilestones.filter((m) => m.status === 'ACHIEVED').length;

  // ── 媒介学习：只看 EnglishMediatedSession ──
  const mediatedRows = await prisma.englishMediatedSession.findMany({
    orderBy: { sessionDate: 'asc' },
    select: {
      sessionDate: true,
      primarySkill: true,
      durationMinutes: true,
      understanding: true,
      translationDependency: true,
      notesEn: true,
      summaryEn: true,
      questionsEn: true,
      outputs: { select: { outputType: true } },
    },
  });

  const intensity: MediatedIntensity = profileCode ? MEDIATED_INTENSITY_BY_PROFILE[profileCode] : 'A2_B1';

  const mediatedEvidence = mediatedRows.map((r) => {
    // 产出数 = 结构化 outputs + 三个内联文本字段（任一非空算 1），口径唯一走 domain
    const outputCount = mediatedOutputCount({
      outputCount: r.outputs.length,
      notesEn: r.notesEn,
      summaryEn: r.summaryEn,
      questionsEn: r.questionsEn,
    });
    return {
      sessionDate: r.sessionDate,
      primarySkill: r.primarySkill,
      durationMinutes: r.durationMinutes,
      understanding: r.understanding,
      translationDependency: r.translationDependency,
      outputCount,
      summaryChars: (r.summaryEn ?? '').length,
    };
  });

  const medGate = evaluateMediatedGate({ records: mediatedEvidence, intensity });
  const medMilestones = medGoal?.milestones ?? [];
  const medAchieved = medMilestones.filter((m) => m.status === 'ACHIEVED').length;

  // 媒介学习的技能分布（用于 currentText 的「已覆盖几项技能」）
  const medSkillShare = skillShare({
    LISTENING: mediatedRows.filter((r) => r.primarySkill === 'LISTENING').reduce((s, r) => s + r.durationMinutes, 0),
    READING: mediatedRows.filter((r) => r.primarySkill === 'READING').reduce((s, r) => s + r.durationMinutes, 0),
    SPEAKING: mediatedRows.filter((r) => r.primarySkill === 'SPEAKING').reduce((s, r) => s + r.durationMinutes, 0),
    WRITING: mediatedRows.filter((r) => r.primarySkill === 'WRITING').reduce((s, r) => s + r.durationMinutes, 0),
    FOUNDATION: 0,
  });
  const medSkillsCovered = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'].filter(
    (s) => (medSkillShare.share[s as 'LISTENING' | 'READING' | 'SPEAKING' | 'WRITING'] ?? 0) > 0,
  ).length;

  const todayStr = nowDate;

  return [
    {
      goalType: 'GENERAL_ENGLISH',
      labelZh: GOAL_TYPE_LABEL_ZH.GENERAL_ENGLISH,
      status: (geGoal?.status as 'ACTIVE') ?? 'ACTIVE',
      targetText: `CEFR ${cefrTarget}`,
      currentText: lowestLevel
        ? `${lowestLevel}（四项最近评估的短板；已评估 ${assessedLevels.length}/4 项）`
        : '尚无能力评估证据',
      progress: goalProgress({ achievedCount: geAchieved, totalCount: geMilestones.length }),
      basis: geGate.basis,
      unmet: geGate.gaps.map((g) => g.label),
      href: GOAL_HREF.GENERAL_ENGLISH,
    },
    {
      goalType: 'IELTS',
      labelZh: GOAL_TYPE_LABEL_ZH.IELTS,
      status: (ieltsGoal?.status as 'ACTIVE') ?? 'ACTIVE',
      targetText: `总分 ${ieltsTarget.overall}${
        ieltsTarget.writing !== null ? `，写作 ≥${ieltsTarget.writing}` : ''
      }${ieltsTarget.speaking !== null ? `，口语 ≥${ieltsTarget.speaking}` : ''}`,
      currentText: latestIelts
        ? `最近${latestIelts.testType === 'OFFICIAL' ? '正式' : '模考'} ${latestIelts.overallBand}（${latestIelts.testDate}）`
        : '尚无正式/模考成绩',
      progress: goalProgress({ achievedCount: ieltsAchieved, totalCount: ieltsMilestones.length }),
      basis: ieltsGate.basis,
      unmet: ieltsGate.gaps.map((g) => g.label),
      href: GOAL_HREF.IELTS,
    },
    {
      goalType: 'ENGLISH_MEDIATED_LEARNING',
      labelZh: GOAL_TYPE_LABEL_ZH.ENGLISH_MEDIATED_LEARNING,
      status: (medGoal?.status as 'ACTIVE') ?? 'ACTIVE',
      targetText: `${mediatedSubject} · ${
        intensity === 'B1_PLUS' ? '系统化' : intensity === 'A2_B1' ? '低强度试学' : '术语接触'
      }`,
      currentText: mediatedRows.length
        ? `${mediatedRows.length} 次记录 · 覆盖 ${medSkillsCovered}/4 项技能`
        : '尚无媒介学习记录',
      progress: goalProgress({ achievedCount: medAchieved, totalCount: medMilestones.length }),
      basis: medGate.basis,
      unmet: medGate.gaps.map((g) => g.label),
      href: GOAL_HREF.ENGLISH_MEDIATED_LEARNING,
    },
  ];
}

/** 轨道本周净分钟（供三目标卡副标题与周复盘共用）。 */
export async function trackWeekMinutes(weekStart: string, weekEnd: string): Promise<Record<LearningTrack, number>> {
  const rows = await prisma.studySessionDaySplit.findMany({
    where: { date: { gte: weekStart, lte: weekEnd } },
    select: { minutes: true, session: { select: { track: true } } },
  });

  const out: Record<LearningTrack, number> = {
    GENERAL_ENGLISH: 0,
    IELTS_PREPARATION: 0,
    ENGLISH_MEDIATED_LEARNING: 0,
  };
  for (const row of rows) {
    const track = row.session?.track as LearningTrack | undefined;
    if (track && TRACKS.includes(track)) {
      out[track] += Math.max(0, row.minutes);
    } else {
      out.GENERAL_ENGLISH += Math.max(0, row.minutes); // 未知轨道归入通用英语
    }
  }
  return out;
}
