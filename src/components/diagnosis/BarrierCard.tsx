'use client';

/**
 * 单条障碍诊断卡：聚焦 / 修复计划 / 前后样本 / 解决 / 归档。
 *
 * 规则提示直接写在卡里：没有后测样本不能标记完成；没有已完成修复不能标记解决。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  changeInterventionStatusAction,
  focusBarrierAction,
  linkInterventionEvidenceAction,
  resolveBarrierAction,
  upsertInterventionAction,
} from '@/lib/actions/barrier';
import {
  ASSISTANCE_LEVEL_LABEL_ZH,
  ASSISTANCE_LEVELS,
  BARRIER_REPAIR_PRESET_ZH,
  BARRIER_STATUS_LABEL_ZH,
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
  INTERVENTION_DEFAULT_SCAFFOLD,
  INTERVENTION_STATUS_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { canCompleteIntervention, nextInterventionStatuses } from '@/lib/domain/barrier';
import type {
  AssistanceLevel,
  BarrierDiagnosisDto,
  BarrierEvidenceOptionDto,
  EvidenceSkill,
  InterventionPlanDto,
  InterventionStatus,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface BarrierCardProps {
  barrier: BarrierDiagnosisDto;
  options: BarrierEvidenceOptionDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
  onArchiveRequest: (barrier: BarrierDiagnosisDto) => void;
}

function evidenceOptionLabel(option: BarrierEvidenceOptionDto): string {
  const date = option.createdAt.slice(0, 10);
  return `${LEARNING_EVIDENCE_TYPE_CODE[option.evidenceType]} ${
    LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]
  } · ${option.independent ? '独立' : '辅助'} · ${date}`;
}

function InterventionEditor({
  barrierId,
  skill,
  initial,
  onClose,
  onToast,
}: {
  barrierId: string;
  skill: EvidenceSkill;
  initial: InterventionPlanDto | null;
  onClose: () => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const preset = BARRIER_REPAIR_PRESET_ZH[skill];
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [action, setAction] = useState(initial?.action ?? preset.action);
  const [successCriteria, setSuccessCriteria] = useState(
    initial?.successCriteria ?? preset.successCriteria,
  );
  const [scaffoldLevel, setScaffoldLevel] = useState<AssistanceLevel>(
    initial?.scaffoldLevel ?? INTERVENTION_DEFAULT_SCAFFOLD,
  );
  const [minutes, setMinutes] = useState(String(initial?.estimatedMinutes ?? preset.minutes));

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await upsertInterventionAction({
        id: initial?.id,
        barrierId,
        action,
        successCriteria,
        scaffoldLevel,
        estimatedMinutes: Number(minutes),
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(initial ? '修复计划已更新' : '修复计划已创建', 'success');
      onClose();
    });
  };

  return (
    <div className="space-y-2 rounded border border-line bg-surfaceAlt p-2">
      <FormField
        label="修复动作"
        htmlFor={`iv-action-${initial?.id ?? 'new'}`}
        error={fieldErrors.action}
        hint="写清楚用什么材料、做几步、每步产出什么"
      >
        <textarea
          id={`iv-action-${initial?.id ?? 'new'}`}
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className={textareaClass}
        />
      </FormField>
      <FormField
        label="成功标准（可观察）"
        htmlFor={`iv-criteria-${initial?.id ?? 'new'}`}
        error={fieldErrors.successCriteria}
        hint="复测时用平行材料验证；不能写「多练几次」"
      >
        <textarea
          id={`iv-criteria-${initial?.id ?? 'new'}`}
          value={successCriteria}
          onChange={(event) => setSuccessCriteria(event.target.value)}
          className={textareaClass}
        />
      </FormField>
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField
          label="修复支架"
          htmlFor={`iv-scaffold-${initial?.id ?? 'new'}`}
          error={fieldErrors.scaffoldLevel}
          hint="A4 代写/代答不能当支架；复测必须撤回到 A0"
        >
          <select
            id={`iv-scaffold-${initial?.id ?? 'new'}`}
            value={scaffoldLevel}
            onChange={(event) => setScaffoldLevel(event.target.value as AssistanceLevel)}
            className={selectClass}
          >
            {ASSISTANCE_LEVELS.filter((item) => item !== 'A4').map((item) => (
              <option key={item} value={item}>
                {ASSISTANCE_LEVEL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="预估分钟" htmlFor={`iv-minutes-${initial?.id ?? 'new'}`} error={fieldErrors.estimatedMinutes}>
          <input
            id={`iv-minutes-${initial?.id ?? 'new'}`}
            type="number"
            min={5}
            max={120}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : '保存修复计划'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}

function InterventionRow({
  intervention,
  barrier,
  options,
  onToast,
}: {
  intervention: InterventionPlanDto;
  barrier: BarrierDiagnosisDto;
  options: BarrierEvidenceOptionDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  const locked = intervention.status === 'DONE' || intervention.status === 'ABANDONED';
  const completionCheck = canCompleteIntervention(intervention.postEvidenceId);

  const changeStatus = (status: InterventionStatus) => {
    startTransition(async () => {
      const result = await changeInterventionStatusAction({ id: intervention.id, status });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('修复状态已更新', 'success');
      router.refresh();
    });
  };

  const linkEvidence = (role: 'PRE' | 'POST', evidenceId: string) => {
    if (!evidenceId) return;
    startTransition(async () => {
      const result = await linkInterventionEvidenceAction({
        id: intervention.id,
        role,
        evidenceId,
      });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('样本已关联', 'success');
      router.refresh();
    });
  };

  return (
    <div className="rounded border border-line p-2">
      {editing ? (
        <InterventionEditor
          barrierId={barrier.id}
          skill={barrier.skill}
          initial={intervention}
          onClose={() => {
            setEditing(false);
            router.refresh();
          }}
          onToast={onToast}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] text-ink">{intervention.action}</p>
              <p className="mt-0.5 text-[11px] text-inkMuted">
                成功标准：{intervention.successCriteria}
              </p>
              <p className="mt-0.5 text-[10px] text-inkMuted">
                支架 {ASSISTANCE_LEVEL_LABEL_ZH[intervention.scaffoldLevel]} · 预计{' '}
                {intervention.estimatedMinutes} 分钟
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <select
                aria-label="修复状态"
                value={intervention.status}
                disabled={pending || locked}
                onChange={(event) => changeStatus(event.target.value as InterventionStatus)}
                className="rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-ink"
              >
                {nextInterventionStatuses(intervention.status).map((item) => (
                  <option key={item} value={item}>
                    {INTERVENTION_STATUS_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
              {!locked && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  编辑
                </Button>
              )}
            </div>
          </div>

          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
            <label className="text-[10px] text-inkMuted">
              修复前样本
              <select
                aria-label="修复前样本"
                value={intervention.preEvidenceId ?? ''}
                disabled={pending || locked}
                onChange={(event) => linkEvidence('PRE', event.target.value)}
                className="mt-0.5 w-full rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-ink"
              >
                <option value="">未关联</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {evidenceOptionLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] text-inkMuted">
              后测样本（复测必须 A0）
              <select
                aria-label="后测样本"
                value={intervention.postEvidenceId ?? ''}
                disabled={pending || locked}
                onChange={(event) => linkEvidence('POST', event.target.value)}
                className="mt-0.5 w-full rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-ink"
              >
                <option value="">未关联</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {evidenceOptionLabel(option)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!locked && intervention.status !== 'DONE' && !completionCheck.ok && (
            <p className="mt-1 text-[10px] text-amber-700">{completionCheck.error}</p>
          )}
        </>
      )}
    </div>
  );
}

export function BarrierCard({ barrier, options, onToast, onArchiveRequest }: BarrierCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);

  const active = barrier.status === 'ACTIVE';
  const archived = barrier.archivedAt !== null;

  const focus = () => {
    startTransition(async () => {
      const result = await focusBarrierAction({ id: barrier.id });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('已设为当前聚焦障碍', 'success');
      router.refresh();
    });
  };

  const resolve = () => {
    startTransition(async () => {
      const result = await resolveBarrierAction({ id: barrier.id });
      if (!result.ok) {
        onToast(result.error, 'error');
        return;
      }
      onToast('障碍已标记为解决', 'success');
      router.refresh();
    });
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          {barrier.selectedFocus && (
            <span className="rounded bg-brand px-1 py-0.5 text-[10px] font-medium text-white">
              当前聚焦
            </span>
          )}
          <span>
            {EVIDENCE_SKILL_LABEL_ZH[barrier.skill]} · {barrier.barrierLabel}
          </span>
          <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-normal text-slate-600">
            {BARRIER_STATUS_LABEL_ZH[barrier.status]}
          </span>
          {archived && (
            <span className="rounded bg-slate-200 px-1 py-0.5 text-[10px] font-normal text-slate-600">
              已归档
            </span>
          )}
        </span>
      }
      description={barrier.impact}
      actions={
        <>
          {active && !barrier.selectedFocus && !archived && (
            <Button variant="ghost" size="sm" onClick={focus} disabled={pending}>
              <Icon name="target" size={13} />
              设为聚焦
            </Button>
          )}
          {active && !archived && (
            <Button variant="ghost" size="sm" onClick={resolve} disabled={pending}>
              <Icon name="check" size={13} />
              标记解决
            </Button>
          )}
          {!archived && (
            <Button variant="ghost" size="sm" onClick={() => onArchiveRequest(barrier)}>
              <Icon name="trash" size={13} />
              归档
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-inkMuted">
          <span>置信度 {EVIDENCE_CONFIDENCE_LABEL_ZH[barrier.confidence]}</span>
          {barrier.evidenceId ? (
            <a className="text-brand underline" href="/evidence">
              原始样本 #{barrier.evidenceId.slice(0, 6)}…
            </a>
          ) : (
            <span>未关联原始样本</span>
          )}
          {barrier.evidenceAnchor && <span>位置：{barrier.evidenceAnchor}</span>}
          <span>记录于 {barrier.createdAt.slice(0, 10)}</span>
        </div>
        {barrier.note && <p className="text-[11px] text-inkMuted">备注：{barrier.note}</p>}

        {barrier.interventions.length === 0 ? (
          <p className="rounded border border-dashed border-line p-2 text-[11px] text-inkMuted">
            还没有修复计划。定向修复需要：具体动作 + 可观察的成功标准 + 前后样本。
          </p>
        ) : (
          <div className="space-y-1.5">
            {barrier.interventions.map((intervention) => (
              <InterventionRow
                key={intervention.id}
                intervention={intervention}
                barrier={barrier}
                options={options}
                onToast={onToast}
              />
            ))}
          </div>
        )}

        {active && !archived && (
          <div>
            {adding ? (
              <InterventionEditor
                barrierId={barrier.id}
                skill={barrier.skill}
                initial={null}
                onClose={() => {
                  setAdding(false);
                  router.refresh();
                }}
                onToast={onToast}
              />
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
                <Icon name="plus" size={13} />
                添加修复计划
              </Button>
            )}
          </div>
        )}

        {barrier.status === 'RESOLVED' && (
          <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900">
            已解决：至少一条修复完成并留下后测样本。复测证据仍保留在 Evidence Center。
          </p>
        )}
      </div>
    </Card>
  );
}
