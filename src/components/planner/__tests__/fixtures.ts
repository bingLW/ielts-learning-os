/** 规划器渲染测试的 DTO 夹具（纯对象，不查库）。 */

import type {
  BuilderContextDto,
  CandidateRowDto,
  DraftDto,
  GapRowDto,
  GapSummaryDto,
  PlanExplanationDto,
  PlannerDashboardDto,
  ReplanContextDto,
} from '@/lib/queries/planner';
import type { ReplanDiff } from '@/lib/domain/planDiff';
import type { PlanLayerStructure } from '@/lib/services/planBuild';
import { DEFAULT_PRIORITY_WEIGHTS } from '@/lib/constants';

export function gapRow(overrides: Partial<GapRowDto> = {}): GapRowDto {
  return {
    id: 'gap-1',
    dimensionKind: 'OFFICIAL',
    skill: 'READING',
    subskill: 'detail_scanning',
    kind: 'GAP',
    confidence: 'MEDIUM',
    evidenceCount: 3,
    independentCount: 2,
    freshnessDays: 4,
    coverageRatio: 0.5,
    severity: 0.62,
    reason: '细节题定位偏差',
    evidenceRefs: ['ev-1', 'ev-2'],
    missingEvidence: [],
    status: 'ACTIVE',
    ...overrides,
  };
}

export function candidateRow(overrides: Partial<CandidateRowDto> = {}): CandidateRowDto {
  return {
    id: 'cand-1',
    candidateKey: 'READING::detail::c1',
    snapshotId: 'snap-1',
    sourceKind: 'PROBE',
    sourceLabel: '基线补测',
    sourceRef: null,
    module: 'READING',
    moduleLabel: '阅读',
    targetSkill: 'READING',
    skillGapId: 'gap-1',
    title: '阅读细节题 8 题',
    estMinutes: 25,
    minMinutes: 10,
    maxBlockMinutes: null,
    prerequisites: [],
    validationStatus: 'VALID',
    difficultyScore: 2,
    isAiSuggested: false,
    status: 'ACTIVE',
    decision: {
      priority: 'P2',
      priorityLabel: 'P2',
      score: 0.5123,
      weightsVersion: 'w1',
      factors: { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0, goalRelevance: 0.5, evidenceStrength: 0.31 },
      rationale: '证据支撑 0.31 主导；预计 25 分钟，今日预算 60 分钟',
      consequenceIfSkipped: null,
      eligibility: 'ELIGIBLE',
      blockedReason: null,
      skillGapKey: 'OFFICIAL:READING:detail_scanning',
      evidenceRefs: ['ev-1'],
      noObservation: false,
    },
    ...overrides,
  };
}

export function dashboardDto(overrides: Partial<PlannerDashboardDto> = {}): PlannerDashboardDto {
  return {
    asOfDate: '2026-11-25',
    diagnosed: true,
    latestSnapshotId: 'snap-1',
    statusBand: {
      stageId: 'stage-1',
      stageCode: 'S2_A2_B1',
      stageName: 'A2→B1 过渡',
      budgetMinutes: 60,
      isRestDay: false,
      isSuggestion: false,
      plannedMinutes: 45,
      actualNetMinutes: 30,
      taskCount: 3,
      doneCount: 1,
      aiMode: 'on',
      aiNote: 'AI 仅润色措辞',
    },
    todayDecision: {
      plannedMinutes: 45,
      doneMinutes: 15,
      taskCount: 3,
      p0Count: 1,
      p1Count: 1,
      top: [],
    },
    pendingConfirmations: [],
    weeklyGap: {
      weekStart: '2026-11-23',
      weekEnd: '2026-11-29',
      targetMinutes: 300,
      capacityMinutes: 300,
      plannedMinutes: 180,
      netMinutes: 120,
    },
    gapTop3: [],
    uncertaintyTop3: [],
    banners: [],
    ...overrides,
  };
}

export function gapSummaryDto(overrides: Partial<GapSummaryDto> = {}): GapSummaryDto {
  return {
    snapshot: {
      id: 'snap-1',
      purpose: 'GENERATE',
      asOfDate: '2026-11-25',
      ruleVersion: 'r1',
      inputHash: 'abcdef1234567890',
      createdAt: '2026-11-25T09:00:00.000Z',
    },
    official: {
      LISTENING: [],
      READING: [gapRow()],
      SPEAKING: [],
      WRITING: [gapRow({ id: 'gap-w', skill: 'WRITING', subskill: 'task2_coherence', reason: '段落衔接弱' })],
    },
    auxiliary: [gapRow({ id: 'gap-aux', dimensionKind: 'AUXILIARY', skill: 'GRAMMAR', subskill: 'tense' })],
    gapCount: 2,
    uncertaintyCount: 0,
    candidateCount: 5,
    ...overrides,
  };
}
export function layerStructure(overrides: Partial<PlanLayerStructure> = {}): PlanLayerStructure {
  return {
    layer: 'MONTH',
    stageGoal: '在 S2_A2_B1 阶段完成「B1 总分 6.0」的训练目标',
    weeklyMilestones: [
      { week: 1, startDate: '2026-11-25', goal: '第 1 周：精听与精读各 2 次' },
      { week: 2, startDate: '2026-12-02', goal: '第 2 周：口语输出 2 次' },
      { week: 3, startDate: '2026-12-09', goal: '第 3 周：写作 Task 2 两篇' },
      { week: 4, startDate: '2026-12-16', goal: '第 4 周：整卷模考与复盘' },
    ],
    skillAllocation: { LISTENING: 25, READING: 25, SPEAKING: 25, WRITING: 25 },
    weeklyTests: '每周完成一次到期证据复测（D7/D14）',
    materialSuggestions: '精听、精读、口语输出、写作各一项',
    vocabGrammarScope: '词汇复习与语法句型训练不进入四技能配比',
    acceptanceCriteria: '四技能各至少 1 项 PASSED',
    adjustmentConditions: '预算变更走重排流程',
    ...overrides,
  };
}

export function builderContext(overrides: Partial<BuilderContextDto> = {}): BuilderContextDto {
  return {
    horizonDays: 7,
    layer: 'WEEK',
    diagnosisReady: true,
    disabledLayers: [],
    layers: [
      {
        layer: 'DAY',
        versionId: '',
        version: 0,
        planDate: '',
        budgetMinutes: 0,
        staleAt: null,
        staleReason: null,
        taskCount: 0,
        structure: null,
      },
      {
        layer: 'WEEK',
        versionId: 'pv-week',
        version: 3,
        planDate: '2026-11-25',
        budgetMinutes: 60,
        staleAt: null,
        staleReason: null,
        taskCount: 12,
        structure: null,
      },
      {
        layer: 'MONTH',
        versionId: 'pv-month',
        version: 2,
        planDate: '2026-11-01',
        budgetMinutes: 0,
        staleAt: '2026-11-20T08:00:00.000Z',
        staleReason: '上层周期主题变更',
        taskCount: 0,
        structure: layerStructure(),
      },
      {
        layer: 'CYCLE',
        versionId: 'pv-cycle',
        version: 1,
        planDate: '2026-09-01',
        budgetMinutes: 0,
        staleAt: null,
        staleReason: null,
        taskCount: 0,
        structure: layerStructure({ layer: 'CYCLE', weeklyMilestones: [
          { week: 1, startDate: '2026-09-01', goal: '第 1 周：校准与基线' },
          { week: 2, startDate: '2026-09-08', goal: '第 2 周：建立节奏' },
        ] }),
      },
    ],
    snapshot: {
      id: 'snap-1',
      asOfDate: '2026-11-25',
      purpose: 'GENERATE',
      ruleVersion: 'r1',
      officialGapCount: 3,
      auxiliaryGapCount: 1,
      candidateCount: 6,
    },
    budget: { minutes: 60, isRestDay: false, isSuggestion: false },
    ...overrides,
  };
}

export function draftDto(overrides: Partial<DraftDto> = {}): DraftDto {
  return {
    draftId: 'snap-draft-12345678',
    purpose: 'GENERATE',
    asOfDate: '2026-11-25',
    ruleVersion: 'r1',
    inputHash: 'abcdef1234567890',
    createdAt: '2026-11-25T09:00:00.000Z',
    budgetJson: {},
    configJson: {},
    validationJson: {},
    officialGapCount: 3,
    auxiliaryGapCount: 1,
    candidateCount: 6,
    ...overrides,
  };
}

export function explanationDto(overrides: Partial<PlanExplanationDto> = {}): PlanExplanationDto {
  return {
    versionId: 'pv-week',
    planDate: '2026-11-25',
    version: 3,
    layer: 'WEEK',
    changeSource: 'GENERATE',
    budgetMinutes: 60,
    createdAt: '2026-11-25T09:00:00.000Z',
    staleAt: null,
    staleReason: null,
    snapshot: { id: 'snap-1', asOfDate: '2026-11-25', purpose: 'GENERATE', ruleVersion: 'r1' },
    snapshotMissing: false,
    goalRef: 'B1 总分 6.0',
    tasks: [
      {
        taskId: 'task-1',
        module: 'READING',
        moduleLabel: '阅读',
        skill: 'READING',
        priority: 'P2',
        priorityLabel: 'P2',
        status: 'TODO',
        plannedMinutes: 25,
        actualMinutes: 0,
        sourceLabel: '基线补测',
        sourceTone: 'neutral',
        explanation: {
          reason: '证据支撑 0.31 主导；预计 25 分钟',
          priority: 'P2',
          score: 0.5123,
          factors: { ...DEFAULT_PRIORITY_WEIGHTS },
          weightsVersion: 'w1',
          gapRef: { skillGapKey: 'OFFICIAL:READING:detail_scanning', evidenceRefs: ['ev-1'] },
          estMinutes: 25,
          minMinutes: 10,
          prerequisites: ['阶段不低于 S2'],
          expectedOutput: null,
          consequenceIfSkipped: null,
          origin: 'RULE',
          wordingSource: 'TEMPLATE',
        },
      },
    ],
    layerStructure: null,
    tradeoffs: {
      totalPlannedMinutes: 25,
      p0Ratio: 0,
      coreRatio: 1,
      extensiveRatio: 0,
      excludedByBudget: [{ title: '写作 Task 2', estMinutes: 40, reason: '超出当日预算' }],
      uncertaintyDeferred: [{ skill: 'SPEAKING', why: '今日预算不足以安排补测' }],
    },
    rejectedAiSuggestions: [],
    aiNote: '本次由规则生成，AI 未参与',
    ...overrides,
  };
}

export function replanContext(overrides: Partial<ReplanContextDto> = {}): ReplanContextDto {
  return {
    planDate: '2026-11-25',
    hasTasks: true,
    budget: { minutes: 60, isRestDay: false },
    actualNetMinutes: 0,
    versionCount: 1,
    lastVersion: 1,
    protectedTaskIds: ['task-done'],
    tasks: [
      {
        taskId: 'task-done',
        module: 'LISTENING',
        moduleLabel: '听力',
        plannedMinutes: 20,
        actualMinutes: 20,
        status: 'DONE',
        priority: 'P1',
        timerStatus: 'STOPPED',
        protected: true,
      },
      {
        taskId: 'task-todo',
        module: 'READING',
        moduleLabel: '阅读',
        plannedMinutes: 30,
        actualMinutes: 0,
        status: 'TODO',
        priority: 'P1',
        timerStatus: 'IDLE',
        protected: false,
      },
    ],
    ...overrides,
  };
}

export function replanDiff(overrides: Partial<ReplanDiff> = {}): ReplanDiff {
  const entries: ReplanDiff['entries'] = [
    {
      kind: 'ADD',
      key: 'new:1',
      title: '口语',
      before: null,
      after: { date: '2026-11-25', minutes: 15, priority: 'P2', module: 'SPEAKING' },
      reason: '预算富余，补一条口语输出',
      protected: false,
    },
    {
      kind: 'REMOVE',
      key: 'task-x',
      title: '写作',
      before: { date: '2026-11-25', minutes: 40, priority: 'P2', module: 'WRITING' },
      after: null,
      reason: '预算不足，顺延到明天',
      protected: false,
    },
    {
      kind: 'MOVE',
      key: 'task-y',
      title: '精听',
      before: { date: '2026-11-25', minutes: 20, priority: 'P1', module: 'LISTENING' },
      after: { date: '2026-11-26', minutes: 20, priority: 'P1', module: 'LISTENING' },
      reason: '改到明天',
      protected: false,
    },
    {
      kind: 'RESIZE',
      key: 'task-z',
      title: '精读',
      before: { date: '2026-11-25', minutes: 30, priority: 'P1', module: 'READING' },
      after: { date: '2026-11-25', minutes: 20, priority: 'P1', module: 'READING' },
      reason: '按剩余预算缩短',
      protected: false,
    },
    {
      kind: 'PRIORITY_CHANGE',
      key: 'task-w',
      title: '语法',
      before: { date: '2026-11-25', minutes: 20, priority: 'P2', module: 'GRAMMAR' },
      after: { date: '2026-11-25', minutes: 20, priority: 'P1', module: 'GRAMMAR' },
      reason: '错题复现提高优先级',
      protected: false,
    },
    {
      kind: 'KEEP',
      key: 'task-done',
      title: '听力',
      before: { date: '2026-11-25', minutes: 20, priority: 'P1', module: 'LISTENING' },
      after: { date: '2026-11-25', minutes: 20, priority: 'P1', module: 'LISTENING' },
      reason: '用户锁定，不参与重排',
      protected: true,
    },
  ];
  return {
    planDate: '2026-11-25',
    entries,
    summary: {
      plannedBefore: 150,
      plannedAfter: 75,
      budget: 40,
      budgetBefore: 60,
      addedCount: 1,
      removedCount: 1,
      movedCount: 1,
      resizedCount: 1,
      priorityChangedCount: 1,
      keptCount: 1,
      p0MinutesBefore: 0,
      p0MinutesAfter: 0,
      protectedMinutes: 20,
      backlogMinutes: 40,
    },
    warnings: [],
    hasChanges: true,
    ...overrides,
  };
}

export function noChangeDiff(): ReplanDiff {
  return replanDiff({
    entries: replanDiff().entries.filter((entry) => entry.kind === 'KEEP'),
    hasChanges: false,
  });
}
