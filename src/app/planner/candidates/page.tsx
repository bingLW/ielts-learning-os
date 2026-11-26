/**
 * `/planner/candidates` 候选队列。
 *
 * 筛选走原生 GET：每个筛选组合都是可分享的地址（`?snapshot=&sourceKind=&skill=…`）。
 * 参数非法时整组忽略并提示，但**不静默** —— 页面上要能看到「本次筛选没生效」。
 */

import { DEFAULT_PRIORITY_WEIGHTS, PRIORITY_THRESHOLDS, PRIORITY_WEIGHTS_VERSION } from '@/lib/constants';
import { getCandidateQueue, getExcludedReasons } from '@/lib/queries/planner';
import { candidateFilterSchema, priorityWeightsConfigSchema, type CandidateFilterInput } from '@/lib/schema/planner';
import { CandidateQueueBody } from '@/components/planner/candidates/CandidateQueueBody';
import { PlannerEmptyState } from '@/components/planner/shared/EmptyState';

export const dynamic = 'force-dynamic';

interface RawParams {
  snapshot?: string;
  sourceKind?: string;
  skill?: string;
  priority?: string;
  minMinutes?: string;
  maxMinutes?: string;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFilter(params: RawParams): { filter: CandidateFilterInput; error: string | null } {
  const parsed = candidateFilterSchema.safeParse({
    sourceKind: params.sourceKind || undefined,
    skill: params.skill || undefined,
    priority: params.priority || undefined,
    minMinutes: toNumber(params.minMinutes),
    maxMinutes: toNumber(params.maxMinutes),
  });
  if (!parsed.success) {
    return { filter: {}, error: parsed.error.issues.map((issue) => issue.message).join('；') };
  }
  return { filter: parsed.data, error: null };
}

export default async function PlannerCandidatesPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const { filter, error: filterError } = parseFilter(params);

  const [queue, excluded] = await Promise.all([
    getCandidateQueue(params.snapshot ?? null, filter),
    getExcludedReasons(params.snapshot ?? null),
  ]);

  if (!queue.snapshotId) {
    return (
      <PlannerEmptyState
        title="还没有候选池"
        description="候选队列来自一次计划生成的快照。先构建一次，再回来挑任务。"
        dependencies={['至少 1 条学习证据', '一次计划生成产生的 PlanningSnapshot']}
        primaryHref="/planner/build"
        primaryLabel="去计划构建"
      />
    );
  }

  const weights = priorityWeightsConfigSchema.safeParse({
    weightsVersion: PRIORITY_WEIGHTS_VERSION,
    weights: DEFAULT_PRIORITY_WEIGHTS,
    thresholds: PRIORITY_THRESHOLDS,
  });
  const weightsError = weights.success
    ? null
    : weights.error.issues.map((issue) => issue.message).join('；');

  return (
    <CandidateQueueBody
      queue={queue}
      excluded={excluded}
      filter={filter}
      weightsInvalid={!weights.success}
      weightsError={weightsError}
      filterError={filterError}
    />
  );
}