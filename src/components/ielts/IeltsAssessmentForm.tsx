'use client';

/**
 * 雅思成绩录入表单（IELTS 轨道）。
 *
 * 一次录入：考试类型（正式/模考/单项）+ 总分（必填）+ 四单项（可选）+ 来源/备注。
 * 这是 IELTS gate 的**唯一证据来源** —— 只读 IeltsAssessment，不读 CEFR 评估。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createIeltsAssessmentAction } from '@/lib/actions/assessment';
import { IELTS_TEST_TYPES, IELTS_TEST_TYPE_LABEL_ZH } from '@/lib/constants';
import { today } from '@/lib/date';
import type { IeltsTestType } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass } from '@/components/ui/FormField';

export interface IeltsAssessmentFormProps {
  onToast: (message: string, tone: 'success' | 'error') => void;
  onSaved: () => void;
}

function BandInput({
  id,
  label,
  value,
  onChange,
  required = false,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <FormField label={label} htmlFor={id} required={required} error={error} hint={hint}>
      <input
        id={id}
        type="number"
        min={0}
        max={9}
        step={0.5}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="如 6.5"
        className={inputClass}
      />
    </FormField>
  );
}

export function IeltsAssessmentForm({ onToast, onSaved }: IeltsAssessmentFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [testDate, setTestDate] = useState(today());
  const [testType, setTestType] = useState<IeltsTestType>('MOCK');
  const [overallBand, setOverallBand] = useState('');
  const [listeningBand, setListeningBand] = useState('');
  const [readingBand, setReadingBand] = useState('');
  const [writingBand, setWritingBand] = useState('');
  const [speakingBand, setSpeakingBand] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await createIeltsAssessmentAction({
        testDate,
        testType,
        overallBand: Number(overallBand),
        listeningBand: listeningBand === '' ? undefined : Number(listeningBand),
        readingBand: readingBand === '' ? undefined : Number(readingBand),
        writingBand: writingBand === '' ? undefined : Number(writingBand),
        speakingBand: speakingBand === '' ? undefined : Number(speakingBand),
        source: source || undefined,
        notes: notes || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('雅思成绩已保存', 'success');
      onSaved();
      router.refresh();
    });
  };

  return (
    <Card
      title="录入雅思成绩"
      description="IELTS gate 只看这里：最近 2–3 次正式/模考成绩稳定达目标（总分 + 已配置单项）才建议升级。单项练习（PRACTICE）不计入判定。"
      actions={
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : '保存成绩'}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <FormField label="日期" htmlFor="ia-testDate" required error={fieldErrors.testDate}>
          <input
            id="ia-testDate"
            type="date"
            value={testDate}
            onChange={(event) => setTestDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="考试类型" htmlFor="ia-testType" required error={fieldErrors.testType}>
          <select
            id="ia-testType"
            value={testType}
            onChange={(event) => setTestType(event.target.value as IeltsTestType)}
            className={selectClass}
          >
            {IELTS_TEST_TYPES.map((item) => (
              <option key={item} value={item}>
                {IELTS_TEST_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <BandInput
          id="ia-overallBand"
          label="总分"
          value={overallBand}
          onChange={setOverallBand}
          required
          error={fieldErrors.overallBand}
          hint="0.5 步进，必填"
        />

        <BandInput
          id="ia-listeningBand"
          label="听力"
          value={listeningBand}
          onChange={setListeningBand}
          error={fieldErrors.listeningBand}
        />

        <BandInput
          id="ia-readingBand"
          label="阅读"
          value={readingBand}
          onChange={setReadingBand}
          error={fieldErrors.readingBand}
        />

        <BandInput
          id="ia-writingBand"
          label="写作"
          value={writingBand}
          onChange={setWritingBand}
          error={fieldErrors.writingBand}
        />

        <BandInput
          id="ia-speakingBand"
          label="口语"
          value={speakingBand}
          onChange={setSpeakingBand}
          error={fieldErrors.speakingBand}
        />

        <FormField label="来源" htmlFor="ia-source" hint="如 Cambridge IELTS 19 Test 2 / BC 官方">
          <input
            id="ia-source"
            type="text"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="可选"
            className={inputClass}
          />
        </FormField>

        <FormField label="备注" htmlFor="ia-notes" className="sm:col-span-2 xl:col-span-3">
          <input
            id="ia-notes"
            type="text"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="考试感受、丢分点等（可选）"
            className={inputClass}
          />
        </FormField>
      </div>
    </Card>
  );
}
