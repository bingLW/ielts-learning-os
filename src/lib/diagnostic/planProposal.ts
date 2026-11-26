/**
 * 诊断计划草案 → Planner 候选的纯函数适配层。
 *
 * 这里只归一输入，不排序、不评分、不装箱，也不创建调度状态；归一后的
 * TaskCandidateDraft 仍由统一 Planner 的 planningSnapshot → scoreCandidate
 * → rankDecisions → generateAdaptivePlan 链路消费。
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidDateString } from '@/lib/date';
import { DIAGNOSTIC_SKILLS, type DiagnosticSkill } from './constants';
import type { PlanPhase, PlanTaskDraft } from './plan';
import { taskAxesOf } from '@/lib/domain/planWriteMap';
import {
  candidateKeyOf,
  sourceRefOf,
  type DiagnosticProposalMetadata,
  type TaskCandidateDraft,
} from '@/lib/domain/taskCandidate';
import { defaultTaskEstimate } from '@/lib/domain/taskEstimate';
import { activatePlanSchema } from '@/lib/schema/diagnostics';
import { fail, failValidation } from '@/lib/result';
import type { ActionResult, ModuleId, SkillId } from '@/lib/types';

const PROPOSAL_WINDOWS = ['7D', '30D', '90D'] as const;
type ProposalWindow = (typeof PROPOSAL_WINDOWS)[number];
type ProposalSkill = DiagnosticSkill | 'META';

/** 诊断域与计划域的显式映射；未知技能没有默认项。 */
const PROPOSAL_AXES: Record<ProposalSkill, { module: ModuleId; targetSkill: SkillId }> = {
  LISTENING: { module: 'LISTENING', targetSkill: 'LISTENING' },
  READING: { module: 'READING', targetSkill: 'READING' },
  SPEAKING: { module: 'SPEAKING', targetSkill: 'SPEAKING' },
  WRITING: { module: 'WRITING', targetSkill: 'WRITING' },
  GRAMMAR: { module: 'GRAMMAR', targetSkill: 'GRAMMAR' },
  VOCABULARY: { module: 'VOCAB_REVIEW', targetSkill: 'VOCAB' },
  SENTENCE_STRUCTURE: { module: 'SENTENCE', targetSkill: 'SENTENCE' },
  EMLR: { module: 'MEDIATED', targetSkill: 'MEDIATED' },
  META: { module: 'REVIEW_PLAN', targetSkill: 'META' },
};

const PROPOSAL_SKILLS = [...DIAGNOSTIC_SKILLS, 'META'] as const;

/**
 * 用户可编辑字段的上限复用 activatePlanSchema；分钟与技能另外要求
 * 真实整数和已知枚举，不使用 z.coerce 把字符串静默转成数字。
 * budget 仅在初始 PlanPhase 中出现，不属于候选载荷，解析时忽略。
 */
const activationPhasesSchema = activatePlanSchema.shape.tasks.unwrap();
const activationTaskSchema = activationPhasesSchema.element.shape.tasks.element;
const proposalTaskSchema = activationTaskSchema.extend({
  minutes: z.number().int().min(5).max(240),
  skill: z.enum(PROPOSAL_SKILLS),
}).strict();
const proposalPhasesSchema = z.array(
  activationPhasesSchema.element.extend({
    tasks: z.array(proposalTaskSchema).max(8),
    budget: z.unknown().optional(),
  }).strict(),
).max(3).superRefine((phases, ctx) => {
  const seen = new Set<ProposalWindow>();
  phases.forEach((phase, index) => {
    if (seen.has(phase.window)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'window'],
        message: `重复的计划窗口：${phase.window}`,
      });
    }
    seen.add(phase.window);
  });
});

/** 与 PlanPhase 的可编辑部分同构；预算摘要不参与候选归一。 */
export type DiagnosticProposalPhase = Omit<PlanPhase, 'tasks' | 'budget'> & {
  tasks: PlanTaskDraft[];
  budget?: unknown;
};

/** 字符串 JSON 的严格入口；损坏输入返回标准 ActionResult，不抛出。 */
export function parseDiagnosticProposalTasksJson(
  tasksJson: string,
): ActionResult<DiagnosticProposalPhase[]> {
  if (typeof tasksJson !== 'string') {
    return fail('VALIDATION', '诊断计划任务必须是 JSON 字符串');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(tasksJson);
  } catch {
    return fail('VALIDATION', '诊断计划任务不是合法 JSON');
  }

  const parsed = proposalPhasesSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error, '诊断计划任务形状不合法');
  return { ok: true, data: parsed.data };
}

export interface BuildDiagnosticProposalCandidatesArgs {
  proposalId: string;
  reportId: string;
  asOfDate: string;
  horizonDays: number;
  /** 调用方给定的最小任务粒度；不得小于系统允许的 5 分钟。 */
  minTaskMinutes: number;
  /** PlanProposal.tasksJson 原文。 */
  tasks: string;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} 不能为空`);
  }
}

/** 只有 Planner 支持的三个视野可以进入候选池。 */
export function proposalWindowForHorizon(horizonDays: number): ProposalWindow {
  if (horizonDays === 1 || horizonDays === 7) return '7D';
  if (horizonDays === 30) return '30D';
  if (horizonDays === 90) return '90D';
  throw new RangeError(`不支持的诊断计划视野：${horizonDays}`);
}

/**
 * 把选中的窗口归一为候选数组。输出顺序即 tasks 顺序，meta.order 从 0 连续编号。
 * 非法输入抛错，避免未知技能或损坏任务悄悄进入统一 Planner。
 */
export function buildDiagnosticProposalCandidates(
  args: BuildDiagnosticProposalCandidatesArgs,
): TaskCandidateDraft[] {
  requireNonEmpty(args.proposalId, 'proposalId');
  requireNonEmpty(args.reportId, 'reportId');
  if (!isValidDateString(args.asOfDate)) {
    throw new RangeError(`无效的计划基准日：${args.asOfDate}`);
  }
  if (!Number.isInteger(args.minTaskMinutes) || args.minTaskMinutes < 5 || args.minTaskMinutes > 240) {
    throw new RangeError(`minTaskMinutes 必须是 5..240 的整数：${args.minTaskMinutes}`);
  }

  const window = proposalWindowForHorizon(args.horizonDays);
  const parsed = parseDiagnosticProposalTasksJson(args.tasks);
  if (!parsed.ok) {
    const detail = parsed.fieldErrors
      ? Object.entries(parsed.fieldErrors).map(([path, message]) => `${path}: ${message}`).join('；')
      : parsed.error;
    throw new TypeError(`诊断计划任务不合法：${detail}`);
  }

  const phase = parsed.data.find((item) => item.window === window);
  if (!phase) return [];

  return phase.tasks.map((task, order) => {
    if (task.minutes < args.minTaskMinutes) {
      throw new RangeError(
        `诊断任务 ${window}[${order}] 的 ${task.minutes} 分钟低于最小粒度 ${args.minTaskMinutes}`,
      );
    }

    const axes = PROPOSAL_AXES[task.skill];
    const sourceRef = sourceRefOf('MATERIAL', `${args.proposalId}:${window}:${order}`);
    const identity = { sourceKind: 'MATERIAL' as const, sourceRef, module: axes.module };
    const derivedAxes = taskAxesOf(axes.module, axes.targetSkill);
    const diagnosticProposal: DiagnosticProposalMetadata = {
      proposalId: args.proposalId,
      reportId: args.reportId,
      window,
      order,
      evidenceRef: task.evidenceRef,
      userReason: task.reason,
    };

    return {
      candidateKey: candidateKeyOf(identity),
      sourceKind: 'MATERIAL',
      sourceRef,
      module: axes.module,
      targetSkill: axes.targetSkill,
      primarySkill: derivedAxes.primarySkill,
      track: derivedAxes.track,
      skillGapKey: null,
      title: task.title,
      estMinutes: task.minutes,
      minMinutes: task.minutes,
      maxBlockMinutes: task.minutes,
      dueDate: null,
      prerequisites: [],
      validationStatus: 'UNVERIFIED',
      difficultyScore: null,
      isAiSuggested: false,
      aiCallLogId: null,
      expectedOutput: '完成任务并记录可检查产出（答案、录音、文字或练习结果）',
      meta: {
        estMinutesSource: 'SOURCE',
        estimate: defaultTaskEstimate(task.minutes),
        diagnosticProposal,
      },
    };
  });
}

export interface DiagnosticProposalFingerprintInput {
  id: string;
  status: string;
  asOfDate: string;
  tasksJson: string;
}

/** 固定字段顺序的 SHA-256；任一字段（包括 tasksJson 原文）变化都会改变指纹。 */
export function diagnosticProposalFingerprint(
  input: DiagnosticProposalFingerprintInput,
): string {
  return createHash('sha256')
    .update(JSON.stringify([input.id, input.status, input.asOfDate, input.tasksJson]))
    .digest('hex');
}
