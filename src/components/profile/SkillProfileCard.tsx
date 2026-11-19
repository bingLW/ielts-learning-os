'use client';

/**
 * 单技能画像卡片：方向 / 置信度 / 证据依据 / 复评日 / 不能推断什么。
 *
 * 系统给建议，人来做判断；「采用建议」只是把建议写进表单，仍需点保存。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertSkillProfileAction } from '@/lib/actions/profile';
import {
  EVIDENCE_CONFIDENCES,
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  PROFILE_DO_NOT_INFER_PRESET,
  PROFILE_REVIEW_DAYS,
  SKILL_DIRECTIONS,
} from '@/lib/constants';
import { addDays } from '@/lib/date';
import type {
  EvidenceConfidence,
  SkillDirection,
  SkillProfileRowDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';

export interface SkillProfileCardProps {
  row: SkillProfileRowDto;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function SkillProfileCard({ row, onToast }: SkillProfileCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [direction, setDirection] = useState<SkillDirection | ''>(row.direction ?? '');
  const [confidence, setConfidence] = useState<EvidenceConfidence>(row.confidence);
  const [basis, setBasis] = useState<string[]>(row.evidenceBasis);
  const [lastAssessedAt, setLastAssessedAt] = useState(row.lastAssessedAt ?? '');
  const [reviewDueAt, setReviewDueAt] = useState(row.reviewDueAt ?? '');
  const [doNotInfer, setDoNotInfer] = useState(row.doNotInfer ?? '');
  const [note, setNote] = useState(row.note ?? '');

  const toggleBasis = (id: string) => {
    setBasis((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const adoptSuggestion = () => {
    setConfidence(row.suggestion);
    if (lastAssessedAt) {
      setReviewDueAt(addDays(lastAssessedAt, PROFILE_REVIEW_DAYS[row.suggestion]));
    }
  };

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await upsertSkillProfileAction({
        skill: row.skill,
        direction: direction || undefined,
        confidence,
        evidenceBasis: basis,
        lastAssessedAt: lastAssessedAt || undefined,
        reviewDueAt: reviewDueAt || undefined,
        doNotInfer: doNotInfer || undefined,
        note: note || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(`${EVIDENCE_SKILL_LABEL_ZH[row.skill]}画像已保存`, 'success');
      router.refresh();
    });
  };

  const unusedSuggestions = row.suggestionReasons.join('；');
  const basisLabel = (id: string) => {
    const option = row.options.find((item) => item.id === id);
    if (!option) return `已失效依据 ${id.slice(0, 6)}…`;
    return `${LEARNING_EVIDENCE_TYPE_CODE[option.evidenceType]} ${LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]}（${option.independent ? '独立' : '辅助'}）`;
  };

  return (
    <Card
      title={`${EVIDENCE_SKILL_LABEL_ZH[row.skill]} · ${row.evidenceCount} 条证据（独立 ${row.independentCount}）`}
      description={`系统建议置信度：${EVIDENCE_CONFIDENCE_LABEL_ZH[row.suggestion]} · ${unusedSuggestions}`}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={adoptSuggestion}>
            采用建议
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
            {pending ? '保存中…' : '保存画像'}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="能力方向" htmlFor={`sp-dir-${row.skill}`} hint="方向性描述，可为空（待评估）">
          <select
            id={`sp-dir-${row.skill}`}
            value={direction}
            onChange={(event) => setDirection(event.target.value as SkillDirection | '')}
            className={selectClass}
          >
            <option value="">待评估</option>
            {SKILL_DIRECTIONS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="置信度" htmlFor={`sp-conf-${row.skill}`} required error={fieldErrors.confidence}>
          <select
            id={`sp-conf-${row.skill}`}
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as EvidenceConfidence)}
            className={selectClass}
          >
            {EVIDENCE_CONFIDENCES.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_CONFIDENCE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="最近评估日" htmlFor={`sp-last-${row.skill}`}>
          <input
            id={`sp-last-${row.skill}`}
            type="date"
            value={lastAssessedAt}
            onChange={(event) => setLastAssessedAt(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField
          label="下次复评日"
          htmlFor={`sp-due-${row.skill}`}
          hint={`建议间隔：低 ${PROFILE_REVIEW_DAYS.LOW} / 中 ${PROFILE_REVIEW_DAYS.MEDIUM} / 高 ${PROFILE_REVIEW_DAYS.HIGH} 天`}
        >
          <input
            id={`sp-due-${row.skill}`}
            type="date"
            value={reviewDueAt}
            onChange={(event) => setReviewDueAt(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="证据依据（可多选）" className="sm:col-span-2 xl:col-span-4" error={fieldErrors.evidenceBasis}>
          {row.options.length === 0 ? (
            <p className="rounded border border-dashed border-line p-2 text-[11px] text-inkMuted">
              该技能还没有证据。先去 <a className="text-brand underline" href="/evidence">Evidence Center</a> 记录一条基线。
            </p>
          ) : (
            <div className="max-h-40 space-y-1 overflow-auto rounded border border-line p-2">
              {row.options.map((option) => (
                <label key={option.id} className="flex items-start gap-1.5 text-[11px] text-ink">
                  <input
                    type="checkbox"
                    checked={basis.includes(option.id)}
                    onChange={() => toggleBasis(option.id)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">
                      {LEARNING_EVIDENCE_TYPE_CODE[option.evidenceType]}{' '}
                      {LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]}
                    </span>
                    <span className={option.independent ? 'text-emerald-700' : 'text-amber-700'}>
                      {option.independent ? ' · 独立' : ' · 辅助'}
                    </span>
                    {option.preview && <span className="text-inkMuted"> · {option.preview}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          {basis.length > 0 && (
            <p className="mt-1 text-[10px] text-inkMuted">
              已选依据：{basis.map((id) => basisLabel(id)).join('；')}
            </p>
          )}
        </FormField>

        {row.gaps.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 sm:col-span-2 xl:col-span-4">
            <p className="font-medium">证据缺口（不阻止保存，但会限制置信度）</p>
            <ul className="mt-0.5 list-disc pl-4">
              {row.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        )}

        <FormField
          label="这次证据不能说明什么"
          htmlFor={`sp-dni-${row.skill}`}
          className="sm:col-span-2 xl:col-span-4"
          hint={
            <button
              type="button"
              className="text-brand underline"
              onClick={() => setDoNotInfer(PROFILE_DO_NOT_INFER_PRESET)}
            >
              填入默认边界说明
            </button>
          }
        >
          <textarea
            id={`sp-dni-${row.skill}`}
            value={doNotInfer}
            onChange={(event) => setDoNotInfer(event.target.value)}
            className={textareaClass}
            placeholder="例如：只验证了熟悉主题的慢速材料；不能说明真实会议听力。"
          />
        </FormField>

        <FormField label="备注" htmlFor={`sp-note-${row.skill}`} className="sm:col-span-2 xl:col-span-4">
          <input
            id={`sp-note-${row.skill}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>
    </Card>
  );
}
