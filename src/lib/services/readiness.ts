import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import {
  computeReadiness,
  READINESS_RULE_VERSION,
  READINESS_STAGE_BLUEPRINTS,
  type EvidenceDistribution,
  type InvalidEvidenceSample,
  type ReadinessDimensionCode,
  type ReadinessInput,
  type ReadinessResult,
  type ReadinessSnapshot,
  type RetestOutcome,
  type SkillCoverage,
} from '@/lib/domain/readiness';
import { DIAGNOSTIC_BLUEPRINT_CODE, levelIndex } from '@/lib/diagnostic/constants';
import { endOfBusinessDay, toBusinessDate } from '@/lib/date';
import { fail, ok } from '@/lib/result';
import type { ActionResult } from '@/lib/types';

const OFFICIAL_SKILLS = ['LISTENING', 'READING', 'SPEAKING', 'WRITING'] as const;
const OFFICIAL_SKILL_SET = new Set<string>(OFFICIAL_SKILLS);

export interface PersistReadinessReviewInput {
  stageId: string;
  asOfDate: string;
  /** 用户 IANA 时区；决定证据查询上界和复测完成业务日。 */
  timeZone: string;
}
export interface PersistReadinessReviewResult {
  reviewId: string;
  outcome: ReadinessResult['outcome'];
  result: ReadinessResult;
}

function emptyEvidence(): EvidenceDistribution {
  return { baseline: 0, immediate: 0, delayed: 0, applied: 0, transfer: 0, independent: 0, independentEvidenceRefs: [] };
}
function officialSkill(skill: string): string {
  return skill === 'SPEAKING_PRODUCTION' || skill === 'SPEAKING_INTERACTION' ? 'SPEAKING' : skill;
}
function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
function technicalFailure(raw: string | null): string | null {
  const value = parseObject(raw);
  if (value.technicalFailed === true || value.status === 'INVALID' || value.failed === true) {
    return text(value.reason) ?? '技术失败';
  }
  return null;
}
function independent(assistanceLevel: string, condition: Record<string, unknown>): boolean {
  if (assistanceLevel !== 'A0') return false;
  const tools = condition.toolsAllowed;
  return !Array.isArray(tools) || tools.length === 0;
}
function contextChanged(parent: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const parentPrompt = text(parent.prompt);
  const parentMaterial = text(parent.materialSource);
  const currentPrompt = text(current.prompt);
  const currentMaterial = text(current.materialSource);
  if (!parentPrompt || !currentPrompt) return false;
  if (currentPrompt === parentPrompt) return false;
  return currentMaterial !== parentMaterial || currentPrompt !== parentPrompt;
}
function evidenceSubskill(condition: Record<string, unknown>, dimensions: Record<string, unknown>): string | null {
  return text(dimensions.subskill) ?? text(condition.subskill);
}
function sourceKindOf(evidenceType: string): string {
  if (evidenceType === 'APPLIED_TASK' || evidenceType === 'TRANSFER') return '真实任务';
  if (evidenceType === 'BASELINE') return '基线任务';
  return '技能复测';
}
function addSourceObservation(
  skill: string,
  sourceRef: string,
  direction: 'MEETS' | 'BELOW',
  evidenceRef: string,
  observations: Map<string, Map<string, SourceObservation>>,
): void {
  const bySource = observations.get(skill) ?? new Map<string, SourceObservation>();
  const current = bySource.get(sourceRef) ?? { direction: 'UNKNOWN', evidenceRefs: [], observedDirections: [] };
  if (!current.observedDirections.includes(direction)) current.observedDirections.push(direction);
  current.direction = current.observedDirections.length === 1 ? direction : 'UNKNOWN';
  current.evidenceRefs.push(evidenceRef);
  bySource.set(sourceRef, current);
  observations.set(skill, bySource);
}

interface SourceObservation {
  direction: 'MEETS' | 'BELOW' | 'UNKNOWN';
  evidenceRefs: string[];
  observedDirections: ('MEETS' | 'BELOW')[];
}

interface EvidenceRow {
  id: string;
  skill: string;
  evidenceType: string;
  assistanceLevel: string;
  score: number | null;
  scoreReason: string | null;
  outputText: string | null;
  dimensionsJson: string | null;
  conditionJson: string | null;
  taskId: string | null;
  sessionId: string | null;
  artifactId: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

function invalidEvidenceReason(row: EvidenceRow, condition: Record<string, unknown>): string | null {
  if (row.archivedAt) return '证据已归档';
  const technical = technicalFailure(row.conditionJson);
  if (technical) return technical;
  if (row.evidenceType === 'ASSISTED') return '辅助样本不能作为完成证据';
  if (typeof row.score !== 'number') return '未评分';
  if (!row.outputText && !row.scoreReason && !row.dimensionsJson && !row.artifactId) return '缺少产出或评分依据';
  if (condition.invalid === true || condition.aborted === true) return '样本中止或标记无效';
  return null;
}

export async function persistReadinessReview(
  input: PersistReadinessReviewInput,
): Promise<ActionResult<PersistReadinessReviewResult>> {
  const stage = await prisma.stage.findUnique({ where: { id: input.stageId } });
  if (!stage) return fail('NOT_FOUND', '阶段不存在');

  const readErrors: ReadinessDimensionCode[] = [];
  const invalidSamples: InvalidEvidenceSample[] = [];
  const coverageBySkill: Record<string, SkillCoverage> = {};
  const evidenceBySkill: Record<string, EvidenceDistribution> = Object.fromEntries(
    OFFICIAL_SKILLS.map((skill) => [skill, emptyEvidence()]),
  );
  const distinctSources: ReadinessInput['distinctSources'] = [];
  let blueprint: ReadinessSnapshot['blueprint'] = { id: '', code: DIAGNOSTIC_BLUEPRINT_CODE, version: '未知', stageProfileCode: stage.profileCode ?? '未知' };
  let evidenceRows: EvidenceRow[] = [];
  const sourceSets = new Map<string, Set<string>>(OFFICIAL_SKILLS.map((skill) => [skill, new Set<string>()]));
  const sourceObservations = new Map<string, Map<string, SourceObservation>>(
    OFFICIAL_SKILLS.map((skill) => [skill, new Map()]),
  );

  try {
    const blueprintRow = await prisma.diagnosticBlueprint.findUnique({
      where: { code: DIAGNOSTIC_BLUEPRINT_CODE },
      include: { items: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
    });
    const range = stage.profileCode ? READINESS_STAGE_BLUEPRINTS[stage.profileCode as keyof typeof READINESS_STAGE_BLUEPRINTS] : undefined;
    if (!blueprintRow || !blueprintRow.active || !range) throw new Error('当前阶段没有可用的激活诊断蓝图');
    blueprint = { id: blueprintRow.id, code: blueprintRow.code, version: blueprintRow.version, stageProfileCode: stage.profileCode! };
    for (const skill of OFFICIAL_SKILLS) {
      const items = blueprintRow.items.filter((item) => {
        const itemSkill = officialSkill(item.skill);
        return itemSkill === skill && item.sourceType !== 'AI_PRACTICE'
          && (item.validationStatus === 'VERIFIED' || item.validationStatus === 'RUBRIC_APPROVED')
          && levelIndex(item.targetLevelMin) <= range.maxLevel && levelIndex(item.targetLevelMax) >= range.minLevel;
      });
      const dimensions = new Map<string, SkillCoverage['dimensions'][number]>();
      for (const item of items) {
        const current = dimensions.get(item.subskill) ?? {
          skill, subskill: item.subskill, completed: false, evidenceRefs: [], sourceKinds: [], itemCodes: [],
        };
        current.itemCodes.push(item.itemCode);
        dimensions.set(item.subskill, current);
      }
      coverageBySkill[skill] = {
        skill, completed: 0, required: dimensions.size,
        coverageRatio: dimensions.size === 0 ? null : 0,
        missingSubskills: [...dimensions.keys()],
        dimensions: [...dimensions.values()], invalidSamples: [],
      };
    }

    const attempts = await prisma.diagnosticAttempt.findMany({
      where: { submittedAt: { lt: endOfBusinessDay(input.asOfDate, input.timeZone) } },
      select: {
        id: true, status: true, score: true, maxScore: true, responseText: true, responseJson: true,
        evaluatorType: true, technicalStatusJson: true, evidenceId: true,
        session: { select: { status: true } },
        item: { select: { itemCode: true, skill: true, subskill: true, taskType: true, blueprintId: true } },
        evidence: { select: { archivedAt: true } },
      },
    });
    for (const attempt of attempts) {
      const skill = officialSkill(attempt.item.skill);
      if (!OFFICIAL_SKILL_SET.has(skill)) continue;
      let reason: string | null = null;
      if (attempt.session.status !== 'COMPLETED') reason = '诊断会话未完成';
      else if (attempt.item.blueprintId !== blueprintRow.id) reason = 'Attempt 不属于当前蓝图';
      else if (attempt.status === 'INVALID') reason = technicalFailure(attempt.technicalStatusJson) ?? 'Attempt 技术无效';
      else if (attempt.status !== 'SCORED') reason = `Attempt 状态为 ${attempt.status}`;
      else if (attempt.evaluatorType === 'INVALID') reason = '评分器无效';
      else if (typeof attempt.score !== 'number' || typeof attempt.maxScore !== 'number' || attempt.maxScore <= 0) reason = '缺少有效评分';
      else if (!attempt.responseText && !attempt.responseJson) reason = '缺少原始作答';
      else if (attempt.evidence?.archivedAt) reason = '关联证据已归档';
      const coverage = coverageBySkill[skill];
      const target = coverage.dimensions.find((row) => row.subskill === attempt.item.subskill);
      if (reason) {
        const sample = { id: attempt.evidenceId ?? attempt.id, sourceType: 'ATTEMPT' as const, skill, subskill: attempt.item.subskill, reason };
        invalidSamples.push(sample);
        coverage.invalidSamples.push(sample);
        continue;
      }
      if (!target) continue;
      const id = attempt.evidenceId ?? attempt.id;
      target.completed = true;
      target.evidenceRefs.push(id);
      target.sourceKinds.push(['MCQ', 'MULTI', 'SHORT_ANSWER'].includes(attempt.item.taskType) ? '客观题' : '开放题');
      const sourceRef = `item:${attempt.item.itemCode}`;
      const sourceSet = distinctSources.find((row) => row.skill === skill);
      const sources = sourceSet ?? { skill, sourceRefs: [] };
      sources.sourceRefs.push(sourceRef);
      sourceSets.get(skill)?.add(sourceRef);
      addSourceObservation(skill, sourceRef, attempt.score! / attempt.maxScore! >= 0.5 ? 'MEETS' : 'BELOW', id, sourceObservations);
      if (!sourceSet) distinctSources.push(sources);
    }
  } catch (error) {
    readErrors.push('D1_EVIDENCE_COVERAGE');
    invalidSamples.push({ id: 'diagnostic-blueprint', sourceType: 'ATTEMPT', skill: 'ALL', reason: error instanceof Error ? error.message : String(error) });
  }

  try {
    evidenceRows = await prisma.evidenceRecord.findMany({
      where: {
        skill: { in: [...OFFICIAL_SKILLS, 'SPEAKING_PRODUCTION', 'SPEAKING_INTERACTION'] },
        archivedAt: null,
        createdAt: { lt: endOfBusinessDay(input.asOfDate, input.timeZone) },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of evidenceRows) {
      const skill = officialSkill(row.skill);
      const condition = parseObject(row.conditionJson);
      const dimensions = parseObject(row.dimensionsJson);
      const reason = invalidEvidenceReason(row, condition);
      const dist = evidenceBySkill[skill];
      if (reason) {
        const sample: InvalidEvidenceSample = { id: row.id, sourceType: 'EVIDENCE', skill, subskill: evidenceSubskill(condition, dimensions) ?? undefined, reason };
        invalidSamples.push(sample);
        coverageBySkill[skill]?.invalidSamples.push(sample);
        continue;
      }
      if (row.evidenceType === 'BASELINE') dist.baseline += 1;
      else if (row.evidenceType === 'IMMEDIATE_RETEST') dist.immediate += 1;
      else if (row.evidenceType === 'DELAYED_RETEST') dist.delayed += 1;
      else if (row.evidenceType === 'APPLIED_TASK') dist.applied += 1;
      else if (row.evidenceType === 'TRANSFER') dist.transfer += 1;
      if (independent(row.assistanceLevel, condition)) {
        dist.independent += 1;
        dist.independentEvidenceRefs.push(row.id);
      }
      const subskill = evidenceSubskill(condition, dimensions);
      const target = coverageBySkill[skill]?.dimensions.find((item) => item.subskill === subskill);
      if (target) {
        target.completed = true;
        target.evidenceRefs.push(row.id);
        target.sourceKinds.push(sourceKindOf(row.evidenceType));
      }
      const source = text(condition.materialSource)
        ? `material:${text(condition.materialSource)}`
        : row.taskId ? `task:${row.taskId}` : row.sessionId ? `session:${row.sessionId}` : null;
      if (source) {
        sourceSets.get(skill)?.add(source);
        addSourceObservation(skill, source, row.score! >= 1 ? 'MEETS' : 'BELOW', row.id, sourceObservations);
      }
    }
    for (const row of distinctSources) {
      for (const source of sourceSets.get(row.skill) ?? []) row.sourceRefs.push(source);
    }
    for (const skill of OFFICIAL_SKILLS) {
      if (!distinctSources.some((row) => row.skill === skill)) {
        distinctSources.push({ skill, sourceRefs: [...(sourceSets.get(skill) ?? [])] });
      }
    }
  } catch (error) {
    readErrors.push('D1_EVIDENCE_COVERAGE', 'D2_CROSS_SOURCE_CONSISTENCY', 'D3_INDEPENDENT_COMPLETION');
    invalidSamples.push({ id: 'evidence-read', sourceType: 'EVIDENCE', skill: 'ALL', reason: error instanceof Error ? error.message : String(error) });
  }

  for (const skill of OFFICIAL_SKILLS) {
    const coverage = coverageBySkill[skill];
    if (!coverage) continue;
    coverage.dimensions.forEach((row) => { row.evidenceRefs = [...new Set(row.evidenceRefs)]; row.sourceKinds = [...new Set(row.sourceKinds)]; });
    coverage.completed = coverage.dimensions.filter((row) => row.completed).length;
    coverage.missingSubskills = coverage.dimensions.filter((row) => !row.completed).map((row) => row.subskill);
    coverage.coverageRatio = coverage.required === 0 ? null : coverage.completed / coverage.required;
  }
  distinctSources.forEach((row) => {
    row.sourceRefs = [...new Set(row.sourceRefs)];
    row.observations = [...(sourceObservations.get(row.skill)?.entries() ?? [])]
      .map(([sourceRef, { direction, evidenceRefs }]) => ({ sourceRef, direction, evidenceRefs }));
  });

  let retestOutcomes: RetestOutcome[] = [];
  try {
    const rows = await prisma.retestSchedule.findMany({
      where: { retestType: { in: ['IMMEDIATE', 'DELAYED', 'APPLIED', 'TRANSFER'] } },
      select: {
        id: true, retestType: true, dueDate: true, status: true, parentEvidenceId: true, completedEvidenceId: true, completedAt: true,
        parent: { select: { id: true, skill: true, conditionJson: true } },
        completed: true,
      },
    });
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
    retestOutcomes = rows.map((row) => {
      const completed = row.completed;
      const skill = officialSkill(row.parent.skill);
      let reason: string | null = null;
      if (row.status === 'DONE' && !completed) reason = '已完成排期缺少完成证据';
      if (completed) {
        const evidence = evidenceById.get(completed.id);
        if (!evidence) reason = '完成证据未读取或不在基准日范围';
        else {
          const condition = parseObject(completed.conditionJson);
          reason = invalidEvidenceReason(completed, condition);
        }
      }
      const condition = completed ? parseObject(completed.conditionJson) : {};
      const valid = row.status === 'DONE' && !reason;
      const isIndependent = Boolean(completed && independent(completed.assistanceLevel, condition));
      const changed = Boolean(completed && contextChanged(parseObject(row.parent.conditionJson), condition));
      const intervalMet = row.status === 'DONE' && row.completedAt !== null
        && toBusinessDate(row.completedAt, input.timeZone) >= row.dueDate;
      if (row.status === 'DONE' && valid) {
        if (!isIndependent) reason = '复测存在辅助，不能作为独立保持/迁移证据';
        else if (!changed) reason = '重复原题或缺少可比较的新任务条件';
        else if (!intervalMet) reason = '未达到规定复测间隔';
      }
      if (reason) invalidSamples.push({ id: completed?.id ?? row.id, sourceType: 'RETEST', skill, reason });
      return {
        id: row.id, retestType: row.retestType as RetestOutcome['retestType'], skill,
        status: row.status as RetestOutcome['status'], score: completed?.score ?? null,
        materialRef: completed ? text(parseObject(completed.conditionJson).materialSource) : null,
        evidenceId: completed?.id ?? row.completedEvidenceId, parentEvidenceId: row.parentEvidenceId,
        valid, independent: isIndependent, contextChanged: changed, intervalMet, invalidReason: reason,
      };
    });
  } catch (error) {
    readErrors.push('D4_DELAYED_RETENTION', 'D5_TRANSFER_EVIDENCE');
    invalidSamples.push({ id: 'retest-read', sourceType: 'RETEST', skill: 'ALL', reason: error instanceof Error ? error.message : String(error) });
  }

  const canonical = JSON.stringify({ stageId: stage.id, asOfDate: input.asOfDate, blueprint, coverageBySkill, evidenceBySkill, distinctSources, retestOutcomes, invalidSamples, readErrors });
  const inputHash = createHash('sha256').update(canonical).digest('hex');
  let planningSnapshot = await prisma.planningSnapshot.findUnique({
    where: { purpose_asOfDate_inputHash: { purpose: 'READINESS', asOfDate: input.asOfDate, inputHash } },
  });
  if (!planningSnapshot) {
    try {
      planningSnapshot = await prisma.planningSnapshot.create({
        data: {
          purpose: 'READINESS', asOfDate: input.asOfDate, inputHash,
          ruleVersion: READINESS_RULE_VERSION, budgetJson: '{}', configJson: JSON.stringify(blueprint),
          profileJson: JSON.stringify({ coverageBySkill, evidenceBySkill, distinctSources }),
          workloadJson: JSON.stringify({ retestOutcomes }),
          validationJson: JSON.stringify({ readErrors, invalidSamples }),
        },
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'P2002')) throw error;
      planningSnapshot = await prisma.planningSnapshot.findUnique({
        where: { purpose_asOfDate_inputHash: { purpose: 'READINESS', asOfDate: input.asOfDate, inputHash } },
      });
    }
  }
  if (!planningSnapshot) return fail('PRECONDITION', '就绪度数据快照落库失败');

  const snapshot: ReadinessSnapshot = {
    ruleVersion: READINESS_RULE_VERSION, dataSnapshotId: planningSnapshot.id,
    computedAt: new Date().toISOString(), blueprint, coverageBySkill, invalidSamples,
  };
  const result = computeReadiness({
    stageId: stage.id, stageStart: stage.startedAt, asOfDate: input.asOfDate,
    officialGaps: [], officialUncertainties: [], evidenceBySkill, retestOutcomes,
    distinctSources, coverageBySkill, readErrors,
  }, snapshot);
  const criteriaJson = JSON.stringify({ schemaVersion: 2, ...result });
  const review = await prisma.stageReadinessReview.create({
    data: {
      snapshotId: planningSnapshot.id, stageId: stage.id, outcome: result.outcome,
      ruleVersion: READINESS_RULE_VERSION, criteriaJson,
      evidenceRefsJson: JSON.stringify([...new Set(result.dimensions.flatMap((row) => row.evidenceRefs))]),
      unmetJson: JSON.stringify(result.unmet), userConfirmed: false,
    },
    select: { id: true },
  });
  return ok({ reviewId: review.id, outcome: result.outcome, result });
}
