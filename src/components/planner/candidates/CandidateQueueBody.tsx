/**
 * `/planner/candidates`：候选池 + 决策轨迹 + 被排除原因 + AI 建议。
 *
 * 权重非法时：顶部红条 + **禁用生成入口**。不静默回落默认权重 ——
 * 用默认权重算出来的计划若被标成「你的权重」，是最难被发现的一类错配。
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { SKILL_IDS, SKILL_LABEL_ZH, TASK_PRIORITIES } from '@/lib/constants';
import { CANDIDATE_SOURCE_KINDS } from '@/lib/domain/taskCandidate';
import type { CandidateFilterInput } from '@/lib/schema/planner';
import { buttonClass } from '@/components/ui/Button';
import type { CandidateQueueDto, ExcludedReasonsDto } from '@/lib/queries/planner';
import { AiSuggestionSection } from './AiSuggestionSection';
import { CandidateTable } from './CandidateTable';
import { ExcludedReasons } from './ExcludedReasons';

const SOURCE_LABEL_ZH: Record<string, string> = {
  REVIEW: '到期复习',
  RETEST: '证据复测',
  PROBE: '基线补测',
  VOCAB: '词汇',
  MATERIAL: '资料研习',
  QUESTION: '错题重做',
  LAB: '专项训练',
  EGIU: '语法单元',
};

function FilterBar({
  snapshotId,
  filter,
}: {
  snapshotId: string;
  filter: CandidateFilterInput;
}) {
  const selectClass = 'rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink';
  return (
    <form method="get" action="/planner/candidates" className="flex flex-wrap items-end gap-2 text-xs">
      <input type="hidden" name="snapshot" value={snapshotId} />
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-inkMuted">来源</span>
        <select name="sourceKind" defaultValue={filter.sourceKind ?? ''} className={selectClass}>
          <option value="">全部来源</option>
          {CANDIDATE_SOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {SOURCE_LABEL_ZH[kind] ?? kind}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-inkMuted">技能</span>
        <select name="skill" defaultValue={filter.skill ?? ''} className={selectClass}>
          <option value="">全部技能</option>
          {SKILL_IDS.map((skill) => (
            <option key={skill} value={skill}>
              {SKILL_LABEL_ZH[skill]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-inkMuted">优先级</span>
        <select name="priority" defaultValue={filter.priority ?? ''} className={selectClass}>
          <option value="">全部</option>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-inkMuted">预计分钟 ≥</span>
        <input
          type="number"
          name="minMinutes"
          min={0}
          max={600}
          defaultValue={filter.minMinutes ?? ''}
          className={`${selectClass} w-20`}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-inkMuted">≤</span>
        <input
          type="number"
          name="maxMinutes"
          min={0}
          max={600}
          defaultValue={filter.maxMinutes ?? ''}
          className={`${selectClass} w-20`}
        />
      </label>
      <button type="submit" className={buttonClass('secondary', 'sm')}>
        筛选
      </button>
      <Link href={`/planner/candidates?snapshot=${snapshotId}`} className="text-[11px] text-brand">
        清除筛选
      </Link>
    </form>
  );
}

export function CandidateQueueBody({
  queue,
  excluded,
  filter,
  weightsInvalid,
  weightsError,
  filterError,
}: {
  queue: CandidateQueueDto;
  excluded: ExcludedReasonsDto;
  filter: CandidateFilterInput;
  weightsInvalid: boolean;
  weightsError: string | null;
  filterError: string | null;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">候选队列</h1>
        <p className="text-xs text-inkMuted">
          快照 {queue.snapshotId.slice(0, 8)} · {queue.total} 条候选 · 排序 = 资格 → 优先级 → 分数 → 身份键
        </p>
      </div>

      {weightsInvalid && (
        <div
          data-testid="weights-invalid"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <p className="font-medium">权重配置不合法：本次不生成计划</p>
          <p className="mt-0.5">{weightsError ?? '七项权重之和必须等于 1，且 P1 阈值必须大于 P2 阈值。'}</p>
          <p className="mt-0.5">系统不会偷偷用默认权重代替你的配置。</p>
        </div>
      )}

      {filterError && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          筛选条件不合法：{filterError}（已忽略本次筛选，显示全部候选）
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar snapshotId={queue.snapshotId} filter={filter} />
        {weightsInvalid ? (
          <span
            aria-disabled="true"
            className={`${buttonClass('primary', 'sm')} pointer-events-none opacity-50`}
            title="权重配置不合法，生成入口已禁用"
          >
            去计划构建
          </span>
        ) : (
          <Link href="/planner/build" className={buttonClass('primary', 'sm')}>
            去计划构建 →
          </Link>
        )}
      </div>

      <Card title={`候选（${queue.total}）`} description="展开任意一条可查看七因子评分轨迹">
        <CandidateTable rows={queue.rows} />
      </Card>

      <ExcludedReasons data={excluded} />

      <AiSuggestionSection rows={queue.rows.filter((row) => row.isAiSuggested)} aiNote={queue.aiNote} />
    </div>
  );
}