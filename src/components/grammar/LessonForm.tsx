'use client';

/**
 * EGIU 单元表单（T21）。
 *
 * 只允许维护元数据（教材 / 单元号 / 知识点 / 首测日）。
 * **颜色不允许手改** —— 它必须由复测判定产生，否则三色就失去意义。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertEgiuLessonAction } from '@/lib/actions/egiu';
import { useBusinessToday } from '@/components/layout/BusinessTimeProvider';
import type { EgiuLessonRowDto, ResourceOptionDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass } from '@/components/ui/FormField';

export interface LessonFormProps {
  editing: EgiuLessonRowDto | null;
  stages: { id: string; nameZh: string; code: string }[];
  resources: ResourceOptionDto[];
  defaultStageId: string | null;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function LessonForm({
  editing,
  stages,
  resources,
  defaultStageId,
  onToast,
  onDone,
}: LessonFormProps) {
  const businessDate = useBusinessToday();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [stageId, setStageId] = useState(
    editing?.stageId ?? defaultStageId ?? stages[0]?.id ?? '',
  );
  const [resourceId, setResourceId] = useState(editing?.resourceId ?? '');
  const [book, setBook] = useState(editing?.book ?? '');
  const [version, setVersion] = useState(editing?.version ?? '');
  const [unitNo, setUnitNo] = useState(editing?.unitNo ?? '');
  const [knowledgePoint, setKnowledgePoint] = useState(editing?.knowledgePoint ?? '');
  const [learnedDate, setLearnedDate] = useState(editing?.learnedDate ?? businessDate);

  const grammarResources = resources.filter(
    (resource) => resource.subject === 'GRAMMAR' || resource.subject === 'EXAM',
  );

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await upsertEgiuLessonAction({
        id: editing?.id,
        stageId,
        resourceId: resourceId || undefined,
        book,
        version: version || undefined,
        unitNo,
        knowledgePoint,
        learnedDate,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(editing ? '单元已更新' : '单元已创建，可以录入首测（D0）了', 'success');
      onDone();
      router.refresh();
    });
  };

  return (
    <Card
      title={editing ? `编辑单元：${editing.book} U${editing.unitNo}` : '新建 EGIU 单元'}
      description="首测日 D0 是复习点起算日，补录时请填真实学习日，不要填今天"
    >
      <div className="grid gap-2 mobile:grid-cols-2 md:grid-cols-3">
        <FormField label="阶段" htmlFor="egiu-stage" required error={fieldErrors.stageId}>
          <select
            id="egiu-stage"
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

        <FormField label="教材资源" htmlFor="egiu-resource" hint="来自资源库，代码里没有资源名" error={fieldErrors.resourceId}>
          <select
            id="egiu-resource"
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
            className={inputClass}
          >
            <option value="">不绑定</option>
            {grammarResources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="教材名（书）" htmlFor="egiu-book" required error={fieldErrors.book}>
          <input
            id="egiu-book"
            value={book}
            onChange={(event) => setBook(event.target.value)}
            placeholder="例如 Essential Grammar in Use"
            className={inputClass}
          />
        </FormField>

        <FormField label="单元号" htmlFor="egiu-unit" required error={fieldErrors.unitNo}>
          <input
            id="egiu-unit"
            value={unitNo}
            onChange={(event) => setUnitNo(event.target.value)}
            placeholder="例如 12 / 12-13"
            className={inputClass}
          />
        </FormField>

        <FormField label="知识点" htmlFor="egiu-point" required error={fieldErrors.knowledgePoint}>
          <input
            id="egiu-point"
            value={knowledgePoint}
            onChange={(event) => setKnowledgePoint(event.target.value)}
            placeholder="例如 一般现在时第三人称单数"
            className={inputClass}
          />
        </FormField>

        <FormField label="首测日 D0" htmlFor="egiu-date" required error={fieldErrors.learnedDate}>
          <input
            id="egiu-date"
            type="date"
            value={learnedDate}
            onChange={(event) => setLearnedDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="版本（可选）" htmlFor="egiu-version" error={fieldErrors.version}>
          <input
            id="egiu-version"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="例如 4th edition"
            className={inputClass}
          />
        </FormField>
      </div>

      <div className="mt-3 flex gap-1.5">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : editing ? '保存修改' : '创建单元'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
      </div>
    </Card>
  );
}
