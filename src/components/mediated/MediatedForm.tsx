'use client';

/**
 * 英语媒介学习记录表单。
 *
 * 一次录入：主题/材料/四技能之一/理解度/翻译依赖 + 英文产出（笔记/摘要/问题至少一项）。
 * 保存后整段落库为一条媒介 session（真值以 StudySession 计，不重复计时长）。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createMediatedSessionAction } from '@/lib/actions/mediated';
import {
  MEDIATED_INTENSITIES,
  MEDIATED_INTENSITY_LABEL_ZH,
  MEDIATED_UNDERSTANDINGS,
  MEDIATED_UNDERSTANDING_LABEL_ZH,
  PRIMARY_SKILLS,
  PRIMARY_SKILL_LABEL_ZH,
  SOURCE_TYPES,
  SOURCE_TYPE_LABEL_ZH,
  TRANSLATION_DEPENDENCIES,
  TRANSLATION_DEPENDENCY_LABEL_ZH,
} from '@/lib/constants';
import { useBusinessToday } from '@/components/layout/BusinessTimeProvider';
import type { MediatedIntensity, MediatedUnderstanding, PrimarySkill, TranslationDependency } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';

export interface MediatedFormProps {
  defaultSubject: string;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onSaved: () => void;
}

export function MediatedForm({ defaultSubject, onToast, onSaved }: MediatedFormProps) {
  const businessDate = useBusinessToday();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [sessionDate, setSessionDate] = useState(businessDate);
  const [subject, setSubject] = useState(defaultSubject);
  const [topic, setTopic] = useState('');
  const [sourceType, setSourceType] = useState<string>('COURSE');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [primarySkill, setPrimarySkill] = useState<PrimarySkill>('LISTENING');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [languageLevel, setLanguageLevel] = useState<string>('');
  const [understanding, setUnderstanding] = useState<MediatedUnderstanding>('PARTIAL');
  const [translationDependency, setTranslationDependency] = useState<TranslationDependency>('SUBTITLE_EN');
  const [intensity, setIntensity] = useState<MediatedIntensity>('A2_B1');
  const [notesEn, setNotesEn] = useState('');
  const [summaryEn, setSummaryEn] = useState('');
  const [questionsEn, setQuestionsEn] = useState('');
  const [note, setNote] = useState('');

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await createMediatedSessionAction({
        sessionDate,
        subject,
        topic,
        sourceType,
        sourceTitle: sourceTitle || undefined,
        sourceUrl: sourceUrl || undefined,
        primarySkill,
        durationMinutes,
        languageLevel: languageLevel || undefined,
        understanding,
        translationDependency,
        intensity,
        notesEn: notesEn || undefined,
        summaryEn: summaryEn || undefined,
        questionsEn: questionsEn || undefined,
        note: note || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('媒介学习记录已保存', 'success');
      onSaved();
      router.refresh();
    });
  };

  return (
    <Card
      title="新建媒介学习记录"
      description="用英语学知识（如 French）的一次完整闭环；英文产出（笔记/摘要/问题）至少填一项。"
      actions={
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : '保存记录'}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <FormField label="日期" htmlFor="m-sessionDate" required error={fieldErrors.sessionDate}>
          <input
            id="m-sessionDate"
            type="date"
            value={sessionDate}
            onChange={(event) => setSessionDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="学科" htmlFor="m-subject" required error={fieldErrors.subject}>
          <input
            id="m-subject"
            type="text"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="French"
            className={inputClass}
          />
        </FormField>

        <FormField label="主题" htmlFor="m-topic" required error={fieldErrors.topic}>
          <input
            id="m-topic"
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="如 French present tense"
            className={inputClass}
          />
        </FormField>

        <FormField label="材料类型" htmlFor="m-sourceType">
          <select
            id="m-sourceType"
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
            className={selectClass}
          >
            {SOURCE_TYPES.map((item) => (
              <option key={item} value={item}>
                {SOURCE_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="材料标题" htmlFor="m-sourceTitle">
          <input
            id="m-sourceTitle"
            type="text"
            value={sourceTitle}
            onChange={(event) => setSourceTitle(event.target.value)}
            placeholder="课程/视频/教材标题"
            className={inputClass}
          />
        </FormField>

        <FormField label="材料链接" htmlFor="m-sourceUrl">
          <input
            id="m-sourceUrl"
            type="text"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://…（可选）"
            className={inputClass}
          />
        </FormField>

        <FormField
          label="主要技能"
          htmlFor="m-primarySkill"
          required
          error={fieldErrors.primarySkill}
          hint="媒介学习是跨技能应用，本段主要锻炼哪项"
        >
          <select
            id="m-primarySkill"
            value={primarySkill}
            onChange={(event) => setPrimarySkill(event.target.value as PrimarySkill)}
            className={selectClass}
          >
            {PRIMARY_SKILLS.filter((s) => s !== 'FOUNDATION').map((item) => (
              <option key={item} value={item}>
                {PRIMARY_SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="时长（分钟）" htmlFor="m-durationMinutes" required error={fieldErrors.durationMinutes}>
          <input
            id="m-durationMinutes"
            type="number"
            min={1}
            max={600}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField label="材料难度自评" htmlFor="m-languageLevel">
          <select
            id="m-languageLevel"
            value={languageLevel}
            onChange={(event) => setLanguageLevel(event.target.value)}
            className={selectClass}
          >
            <option value="">未标注</option>
            <option value="A2">A2</option>
            <option value="B1">B1</option>
            <option value="B2">B2</option>
            <option value="C1">C1</option>
          </select>
        </FormField>

        <FormField label="理解情况" htmlFor="m-understanding" required error={fieldErrors.understanding}>
          <select
            id="m-understanding"
            value={understanding}
            onChange={(event) => setUnderstanding(event.target.value as MediatedUnderstanding)}
            className={selectClass}
          >
            {MEDIATED_UNDERSTANDINGS.map((item) => (
              <option key={item} value={item}>
                {MEDIATED_UNDERSTANDING_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="翻译依赖"
          htmlFor="m-translationDependency"
          required
          error={fieldErrors.translationDependency}
        >
          <select
            id="m-translationDependency"
            value={translationDependency}
            onChange={(event) => setTranslationDependency(event.target.value as TranslationDependency)}
            className={selectClass}
          >
            {TRANSLATION_DEPENDENCIES.map((item) => (
              <option key={item} value={item}>
                {TRANSLATION_DEPENDENCY_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="强度档" htmlFor="m-intensity" hint="按当前阶段建议，可手动覆盖">
          <select
            id="m-intensity"
            value={intensity}
            onChange={(event) => setIntensity(event.target.value as MediatedIntensity)}
            className={selectClass}
          >
            {MEDIATED_INTENSITIES.map((item) => (
              <option key={item} value={item}>
                {MEDIATED_INTENSITY_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <FormField label="英文笔记" htmlFor="m-notesEn" error={fieldErrors.notesEn}>
          <textarea
            id="m-notesEn"
            value={notesEn}
            onChange={(event) => setNotesEn(event.target.value)}
            placeholder="用英语记下关键点"
            className={textareaClass}
          />
        </FormField>

        <FormField label="英文摘要" htmlFor="m-summaryEn" hint="80–120 词级别">
          <textarea
            id="m-summaryEn"
            value={summaryEn}
            onChange={(event) => setSummaryEn(event.target.value)}
            placeholder="用英语概括这段材料"
            className={textareaClass}
          />
        </FormField>

        <FormField label="英文提问" htmlFor="m-questionsEn">
          <textarea
            id="m-questionsEn"
            value={questionsEn}
            onChange={(event) => setQuestionsEn(event.target.value)}
            placeholder="用英语提出还不懂的问题"
            className={textareaClass}
          />
        </FormField>
      </div>

      <div className="mt-2">
        <FormField label="备注" htmlFor="m-note">
          <input
            id="m-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="写给自己的补充说明（可选）"
            className={inputClass}
          />
        </FormField>
      </div>
    </Card>
  );
}
