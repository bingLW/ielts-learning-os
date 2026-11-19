'use client';

/**
 * 新建障碍诊断。
 *
 * 障碍类型随技能切换；原始样本只能从同技能的活动证据里选。
 */

import { useState, useTransition } from 'react';
import { createBarrierAction } from '@/lib/actions/barrier';
import {
  BARRIER_IMPACT_MIN_CHARS,
  BARRIER_TYPES_BY_SKILL,
  BARRIER_TYPE_LABEL_ZH,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_SKILLS,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
} from '@/lib/constants';
import type {
  BarrierEvidenceOptionsBySkill,
  EvidenceConfidence,
  EvidenceSkill,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface BarrierFormProps {
  optionsBySkill: BarrierEvidenceOptionsBySkill;
  onSaved: (barrierId: string) => void;
  onCancel: () => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function BarrierForm({ optionsBySkill, onSaved, onCancel, onToast }: BarrierFormProps) {
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [skill, setSkill] = useState<EvidenceSkill>('LISTENING');
  const [barrierType, setBarrierType] = useState<string>(BARRIER_TYPES_BY_SKILL.LISTENING[0]);
  const [impact, setImpact] = useState('');
  const [confidence, setConfidence] = useState<EvidenceConfidence>('MEDIUM');
  const [evidenceId, setEvidenceId] = useState('');
  const [evidenceAnchor, setEvidenceAnchor] = useState('');
  const [note, setNote] = useState('');

  const options = optionsBySkill[skill] ?? [];

  const changeSkill = (next: EvidenceSkill) => {
    setSkill(next);
    setBarrierType(BARRIER_TYPES_BY_SKILL[next][0]);
    setEvidenceId('');
  };

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await createBarrierAction({
        skill,
        barrierType,
        evidenceId: evidenceId || undefined,
        evidenceAnchor: evidenceAnchor || undefined,
        impact,
        confidence,
        note: note || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('障碍诊断已记录', 'success');
      onSaved(result.data.barrierId);
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="技能" htmlFor="barrier-skill" required>
          <select
            id="barrier-skill"
            value={skill}
            onChange={(event) => changeSkill(event.target.value as EvidenceSkill)}
            className={selectClass}
          >
            {EVIDENCE_SKILLS.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="障碍类型" htmlFor="barrier-type" required error={fieldErrors.barrierType}>
          <select
            id="barrier-type"
            value={barrierType}
            onChange={(event) => setBarrierType(event.target.value)}
            className={selectClass}
          >
            {BARRIER_TYPES_BY_SKILL[skill].map((item) => (
              <option key={item} value={item}>
                {BARRIER_TYPE_LABEL_ZH[item] ?? item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="置信度" htmlFor="barrier-confidence">
          <select
            id="barrier-confidence"
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

        <FormField label="原始样本（可选）" htmlFor="barrier-evidence" error={fieldErrors.evidenceId}>
          <select
            id="barrier-evidence"
            value={evidenceId}
            onChange={(event) => setEvidenceId(event.target.value)}
            className={selectClass}
          >
            <option value="">暂不关联</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {LEARNING_EVIDENCE_TYPE_CODE[option.evidenceType]}{' '}
                {LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]}
                {option.independent ? ' · 独立' : ' · 辅助'}
                {option.preview ? ` · ${option.preview.slice(0, 36)}` : ''}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="样本位置"
          htmlFor="barrier-anchor"
          className="sm:col-span-2 xl:col-span-4"
          hint="句子 / 段落 / 时间戳 / 题号——方便回看原样本"
        >
          <input
            id="barrier-anchor"
            value={evidenceAnchor}
            onChange={(event) => setEvidenceAnchor(event.target.value)}
            className={inputClass}
            placeholder="例：第 2 段第 3 句 / 00:42–00:55 / Part 2 Q14–16"
          />
        </FormField>

        <FormField
          label="这个障碍怎样影响表现"
          htmlFor="barrier-impact"
          className="sm:col-span-2 xl:col-span-4"
          required
          error={fieldErrors.impact}
          hint={`描述可观察的表现，至少 ${BARRIER_IMPACT_MIN_CHARS} 字`}
        >
          <textarea
            id="barrier-impact"
            value={impact}
            onChange={(event) => setImpact(event.target.value)}
            className={textareaClass}
            placeholder="例：听同一段材料时，连续 3 句因速度跟不上而丢失主句；回看原文发现是词界切分问题。"
          />
        </FormField>

        <FormField label="备注" htmlFor="barrier-note" className="sm:col-span-2 xl:col-span-4">
          <input
            id="barrier-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          <Icon name="check" size={14} />
          {pending ? '保存中…' : '记录诊断'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
