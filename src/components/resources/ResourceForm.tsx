'use client';

/**
 * 资源新增 / 编辑表单。
 *
 * 资源是纯数据：科目与类型来自结构枚举，资源名完全由用户/seed 决定，
 * 代码里不存在任何资源名。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertResourceAction } from '@/lib/actions/resources';
import {
  RESOURCE_SUBJECTS,
  RESOURCE_SUBJECT_LABEL_ZH,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABEL_ZH,
  STAGE_CODES,
  type ResourceSubject,
  type ResourceType,
} from '@/lib/constants';
import type { ResourceRowDto, StageCode } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';

export interface ResourceFormProps {
  editing: ResourceRowDto | null;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function ResourceForm({ editing, onToast, onDone }: ResourceFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [name, setName] = useState(editing?.name ?? '');
  const [subject, setSubject] = useState<ResourceSubject>(
    (editing?.subject as ResourceSubject) ?? 'GRAMMAR',
  );
  const [type, setType] = useState<ResourceType>((editing?.type as ResourceType) ?? 'BOOK');
  const [applicableStages, setApplicableStages] = useState<StageCode[]>(
    (editing?.applicableStages as StageCode[] | undefined) ?? ['S1_A0_A2'],
  );
  const [version, setVersion] = useState(editing?.version ?? '');
  const [totalUnits, setTotalUnits] = useState(editing?.totalUnits ?? 0);
  const [currentUnit, setCurrentUnit] = useState(editing?.currentUnit ?? 0);
  const [startDate, setStartDate] = useState(editing?.startDate ?? '');
  const [finishDate, setFinishDate] = useState(editing?.finishDate ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [isPrimary, setIsPrimary] = useState(editing?.isPrimary ?? false);

  const toggleStage = (code: StageCode) => {
    setApplicableStages((prev) =>
      prev.includes(code) ? prev.filter((item) => item !== code) : [...prev, code],
    );
  };

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await upsertResourceAction({
        ...(editing ? { id: editing.id } : {}),
        name,
        subject,
        type,
        applicableStages,
        version: version || undefined,
        totalUnits: totalUnits || undefined,
        currentUnit: currentUnit || undefined,
        startDate: startDate || undefined,
        finishDate: finishDate || undefined,
        url: url || undefined,
        note: note || undefined,
        isPrimary,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(editing ? '资源已更新' : '资源已新增（记录表单下拉立即生效）', 'success');
      onDone();
      router.refresh();
    });
  };

  return (
    <Card
      title={editing ? `编辑资源：${editing.name}` : '新增资源'}
      description="资源库数据驱动：新增后无需重启即可在记录表单、计划任务里选择。"
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onDone}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="名称" htmlFor="res-name" required error={fieldErrors.name} className="sm:col-span-2">
          <input
            id="res-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="科目" htmlFor="res-subject" required error={fieldErrors.subject}>
          <select
            id="res-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value as ResourceSubject)}
            className={selectClass}
          >
            {RESOURCE_SUBJECTS.map((item) => (
              <option key={item} value={item}>
                {RESOURCE_SUBJECT_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="类型" htmlFor="res-type" required error={fieldErrors.type}>
          <select
            id="res-type"
            value={type}
            onChange={(event) => setType(event.target.value as ResourceType)}
            className={selectClass}
          >
            {RESOURCE_TYPES.map((item) => (
              <option key={item} value={item}>
                {RESOURCE_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="版本" htmlFor="res-version">
          <input
            id="res-version"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="总章节" htmlFor="res-total">
          <input
            id="res-total"
            type="number"
            min={0}
            value={totalUnits}
            onChange={(event) => setTotalUnits(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField label="当前进度" htmlFor="res-current">
          <input
            id="res-current"
            type="number"
            min={0}
            value={currentUnit}
            onChange={(event) => setCurrentUnit(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField label="开始日期" htmlFor="res-start">
          <input
            id="res-start"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="完成日期" htmlFor="res-finish">
          <input
            id="res-finish"
            type="date"
            value={finishDate}
            onChange={(event) => setFinishDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="链接" htmlFor="res-url" error={fieldErrors.url} className="sm:col-span-2">
          <input
            id="res-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
            className={inputClass}
          />
        </FormField>

        <FormField label="适用阶段" required error={fieldErrors.applicableStages} className="sm:col-span-2">
          <div className="flex flex-wrap gap-1.5">
            {STAGE_CODES.map((code) => {
              const checked = applicableStages.includes(code);
              return (
                <label
                  key={code}
                  className={[
                    'cursor-pointer rounded border px-2 py-0.5 text-[11px]',
                    checked ? 'border-brand bg-blue-50 text-brand' : 'border-line bg-white text-inkMuted',
                  ].join(' ')}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => toggleStage(code)}
                  />
                  {code.replace('_', ' ')}
                </label>
              );
            })}
          </div>
        </FormField>

        <FormField label="备注" htmlFor="res-note" className="sm:col-span-2 xl:col-span-4">
          <textarea
            id="res-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={textareaClass}
          />
        </FormField>

        <FormField label="主材料" hint="SOP：每项能力固定一个主材料，连续使用 ≥4 周">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(event) => setIsPrimary(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            {isPrimary ? '是主材料' : '不是主材料'}
          </label>
        </FormField>
      </div>
    </Card>
  );
}
