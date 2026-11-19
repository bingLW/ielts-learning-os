'use client';

/**
 * 错题表单（T25）：新建 / 编辑。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createMistakeAction, updateMistakeAction } from '@/lib/actions/mistakes';
import {
  ERROR_CATEGORY_LABEL_ZH,
  IELTS_ERROR_CATEGORY_LABEL_ZH,
  MISTAKE_SOURCE_LABEL_ZH,
  MISTAKE_SOURCES,
} from '@/lib/constants';
import type {
  ErrorCategory,
  IeltsErrorCategory,
  MistakeRowDto,
  MistakeSource,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';

export interface MistakeFormProps {
  editing: MistakeRowDto | null;
  stages: { id: string; nameZh: string }[];
  defaultStageId: string | null;
  errorCategories: readonly ErrorCategory[];
  ieltsCategories: readonly IeltsErrorCategory[];
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function MistakeForm({
  editing,
  stages,
  defaultStageId,
  errorCategories,
  ieltsCategories,
  onToast,
  onDone,
}: MistakeFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [stageId, setStageId] = useState(editing?.stageId ?? defaultStageId ?? stages[0]?.id ?? '');
  const [sourceType, setSourceType] = useState<MistakeSource>(editing?.sourceType ?? 'MANUAL');
  const [originalQuestion, setOriginalQuestion] = useState(editing?.originalQuestion ?? '');
  const [myAnswer, setMyAnswer] = useState(editing?.myAnswer ?? '');
  const [correctAnswer, setCorrectAnswer] = useState(editing?.correctAnswer ?? '');
  const [errorReason, setErrorReason] = useState(editing?.errorReason ?? '');
  const [knowledgePoint, setKnowledgePoint] = useState(editing?.knowledgePoint ?? '');
  const [errorCategory, setErrorCategory] = useState<ErrorCategory>(
    editing?.errorCategory ?? 'RULE_NOT_UNDERSTOOD',
  );
  const [ieltsErrorCategory, setIeltsErrorCategory] = useState<IeltsErrorCategory | ''>(
    editing?.ieltsErrorCategory ?? '',
  );

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const payload = {
        id: editing?.id,
        stageId,
        sourceType,
        originalQuestion,
        myAnswer: myAnswer || undefined,
        correctAnswer,
        errorReason,
        knowledgePoint,
        errorCategory,
        ieltsErrorCategory: ieltsErrorCategory || undefined,
      };
      const result = editing
        ? await updateMistakeAction(payload)
        : await createMistakeAction(payload);

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(editing ? '错题已更新' : '错题已录入', 'success');
      onDone();
      router.refresh();
    });
  };

  return (
    <Card title={editing ? '编辑错题' : '录入错题'} description="知识点是薄弱点聚合键，请用统一说法">
      <div className="grid gap-2 mobile:grid-cols-2 md:grid-cols-3">
        <FormField label="阶段" htmlFor="mk-stage" required error={fieldErrors.stageId}>
          <select
            id="mk-stage"
            value={stageId}
            onChange={(event) => setStageId(event.target.value)}
            className={inputClass}
          >
            <option value="">请选择阶段</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.nameZh}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="来源" htmlFor="mk-source" required error={fieldErrors.sourceType}>
          <select
            id="mk-source"
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value as MistakeSource)}
            className={inputClass}
          >
            {MISTAKE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {MISTAKE_SOURCE_LABEL_ZH[source]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="知识点" htmlFor="mk-point" required error={fieldErrors.knowledgePoint}>
          <input
            id="mk-point"
            value={knowledgePoint}
            onChange={(event) => setKnowledgePoint(event.target.value)}
            placeholder="例如 定语从句关系词选择"
            className={inputClass}
          />
        </FormField>

        <FormField label="错误类别（6 类必填）" htmlFor="mk-cat" required error={fieldErrors.errorCategory}>
          <select
            id="mk-cat"
            value={errorCategory}
            onChange={(event) => setErrorCategory(event.target.value as ErrorCategory)}
            className={inputClass}
          >
            {errorCategories.map((category) => (
              <option key={category} value={category}>
                {ERROR_CATEGORY_LABEL_ZH[category]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="雅思错因（选填，仅 S3）"
          htmlFor="mk-ielts"
          hint="S3 阶段建议填写，用于题型归因"
          error={fieldErrors.ieltsErrorCategory}
        >
          <select
            id="mk-ielts"
            value={ieltsErrorCategory}
            onChange={(event) => setIeltsErrorCategory(event.target.value as IeltsErrorCategory | '')}
            className={inputClass}
          >
            <option value="">不填</option>
            {ieltsCategories.map((category) => (
              <option key={category} value={category}>
                {IELTS_ERROR_CATEGORY_LABEL_ZH[category]}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <FormField label="原题" htmlFor="mk-question" required error={fieldErrors.originalQuestion}>
          <textarea
            id="mk-question"
            value={originalQuestion}
            onChange={(event) => setOriginalQuestion(event.target.value)}
            className={textareaClass}
            placeholder="抄原文题干（含选项）"
          />
        </FormField>
        <div className="grid gap-2">
          <FormField label="我的答案" htmlFor="mk-my" error={fieldErrors.myAnswer}>
            <input
              id="mk-my"
              value={myAnswer}
              onChange={(event) => setMyAnswer(event.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label="正确答案" htmlFor="mk-correct" required error={fieldErrors.correctAnswer}>
            <input
              id="mk-correct"
              value={correctAnswer}
              onChange={(event) => setCorrectAnswer(event.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>
      </div>

      <div className="mt-2">
        <FormField label="错误原因（写清「我为什么错」）" htmlFor="mk-reason" required error={fieldErrors.errorReason}>
          <textarea
            id="mk-reason"
            value={errorReason}
            onChange={(event) => setErrorReason(event.target.value)}
            className={textareaClass}
            placeholder="例如：把 which 当成了指人的关系代词，忽略了先行词是物"
          />
        </FormField>
      </div>

      <div className="mt-3 flex gap-1.5">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : editing ? '保存修改' : '录入错题'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
      </div>
    </Card>
  );
}
