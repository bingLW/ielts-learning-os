'use client';

/**
 * CEFR 能力评估录入表单（通用英语轨道）。
 *
 * 一次录入：技能 / CEFR 等级 / 评估方式 / 日期 / 评估者 / 置信度（可选分数与备注）。
 * 这是 General English gate 的**唯一证据来源** —— 学习时长不参与判定。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSkillAssessmentAction } from '@/lib/actions/assessment';
import {
  ALLOCATION_SKILLS,
  ASSESSMENT_TYPES,
  ASSESSMENT_TYPE_LABEL_ZH,
  ASSESSOR_KINDS,
  ASSESSOR_LABEL_ZH,
  CEFR_LEVELS,
  PRIMARY_SKILL_LABEL_ZH,
} from '@/lib/constants';
import { useBusinessToday } from '@/components/layout/BusinessTimeProvider';
import type { AllocationSkill, AssessmentType, AssessorKind, CefrLevel } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass } from '@/components/ui/FormField';

export interface SkillAssessmentFormProps {
  onToast: (message: string, tone: 'success' | 'error') => void;
  onSaved: () => void;
}

export function SkillAssessmentForm({ onToast, onSaved }: SkillAssessmentFormProps) {
  const businessDate = useBusinessToday();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [skill, setSkill] = useState<AllocationSkill>('LISTENING');
  const [cefrLevel, setCefrLevel] = useState<CefrLevel>('B1');
  const [assessmentType, setAssessmentType] = useState<AssessmentType>('SELF');
  const [score, setScore] = useState('');
  const [assessDate, setAssessDate] = useState(businessDate);
  const [assessor, setAssessor] = useState<AssessorKind>('SELF');
  const [confidence, setConfidence] = useState(3);
  const [note, setNote] = useState('');

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await createSkillAssessmentAction({
        skill,
        cefrLevel,
        assessmentType,
        score: score || undefined,
        assessDate,
        assessor,
        confidence,
        note: note || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('能力评估已保存', 'success');
      onSaved();
      router.refresh();
    });
  };

  return (
    <Card
      title="录入 CEFR 能力评估"
      description="General English gate 只看这里：四项技能各有评估证据、且最近等级达目标，才建议升级。学习时长不参与判定。"
      actions={
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : '保存评估'}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <FormField label="技能" htmlFor="sa-skill" required error={fieldErrors.skill}>
          <select
            id="sa-skill"
            value={skill}
            onChange={(event) => setSkill(event.target.value as AllocationSkill)}
            className={selectClass}
          >
            {ALLOCATION_SKILLS.map((item) => (
              <option key={item} value={item}>
                {PRIMARY_SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="CEFR 等级" htmlFor="sa-cefrLevel" required error={fieldErrors.cefrLevel}>
          <select
            id="sa-cefrLevel"
            value={cefrLevel}
            onChange={(event) => setCefrLevel(event.target.value as CefrLevel)}
            className={selectClass}
          >
            {CEFR_LEVELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="评估方式"
          htmlFor="sa-assessmentType"
          required
          error={fieldErrors.assessmentType}
        >
          <select
            id="sa-assessmentType"
            value={assessmentType}
            onChange={(event) => setAssessmentType(event.target.value as AssessmentType)}
            className={selectClass}
          >
            {ASSESSMENT_TYPES.map((item) => (
              <option key={item} value={item}>
                {ASSESSMENT_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="日期" htmlFor="sa-assessDate" required error={fieldErrors.assessDate}>
          <input
            id="sa-assessDate"
            type="date"
            value={assessDate}
            onChange={(event) => setAssessDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="评估者" htmlFor="sa-assessor" error={fieldErrors.assessor}>
          <select
            id="sa-assessor"
            value={assessor}
            onChange={(event) => setAssessor(event.target.value as AssessorKind)}
            className={selectClass}
          >
            {ASSESSOR_KINDS.map((item) => (
              <option key={item} value={item}>
                {ASSESSOR_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="置信度"
          htmlFor="sa-confidence"
          hint="1 = 很不可靠 · 5 = 很可靠"
          error={fieldErrors.confidence}
        >
          <select
            id="sa-confidence"
            value={confidence}
            onChange={(event) => setConfidence(Number(event.target.value))}
            className={selectClass}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} 级
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="分数 / 量表" htmlFor="sa-score" hint="如「雅思听力 6.0」「教师反馈 B1+」">
          <input
            id="sa-score"
            type="text"
            value={score}
            onChange={(event) => setScore(event.target.value)}
            placeholder="可选"
            className={inputClass}
          />
        </FormField>

        <FormField label="备注" htmlFor="sa-note" className="sm:col-span-2 xl:col-span-3">
          <input
            id="sa-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="评估来源、依据等补充说明（可选）"
            className={inputClass}
          />
        </FormField>
      </div>
    </Card>
  );
}
