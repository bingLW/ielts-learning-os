'use client';

/**
 * 学习记录表单（17 通用字段 + 4 科扩展）。
 *
 * 两个必须成立的行为：
 * 1. 正确率只读，由 `correct/total` 实时算；`total=0` 显示「无题量数据」而不是 0%；
 * 2. 「产出」与「问题」至少填一项（G2），前端给提示、服务端 zod 再拦一次。
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createStudyRecordAction, updateStudyRecordAction } from '@/lib/actions/records';
import {
  ERROR_CATEGORIES,
  ERROR_CATEGORY_LABEL_ZH,
  LEARNING_TRACKS,
  PRIMARY_SKILLS,
  PRIMARY_SKILL_LABEL_ZH,
  SKILL_IDS,
  SKILL_LABEL_ZH,
  TASK_STATUS_LABEL_ZH,
  TASK_STATUSES,
  TRACK_LABEL_ZH,
  TRACK_SUBTITLE_ZH,
} from '@/lib/constants';
import { accuracyOf } from '@/lib/domain/accuracy';
import { formatPercent } from '@/lib/format';
import type {
  Difficulty,
  LearningTrack,
  PrimarySkill,
  ResourceOptionDto,
  SkillId,
  StudyRecordDetailDto,
  TaskStatus,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { hasExtFields, SkillExtFields, type ExtValues } from './SkillExtFields';

export interface RecordFormProps {
  mode: 'create' | 'edit';
  initial?: StudyRecordDetailDto;
  stages: { id: string; nameZh: string }[];
  resources: ResourceOptionDto[];
  defaultStageId: string;
  defaultRecordDate: string;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onSaved?: (recordId: string) => void;
}

const DIFFICULTY_OPTIONS: { value: Difficulty | ''; label: string }[] = [
  { value: '', label: '未标注' },
  { value: 'EASY', label: '简单' },
  { value: 'MEDIUM', label: '中等' },
  { value: 'HARD', label: '困难' },
];

export function RecordForm({
  mode,
  initial,
  stages,
  resources,
  defaultStageId,
  defaultRecordDate,
  onToast,
  onSaved,
}: RecordFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [stageId, setStageId] = useState(initial?.stageId ?? defaultStageId);
  const [recordDate, setRecordDate] = useState(initial?.recordDate ?? defaultRecordDate);
  const [skill, setSkill] = useState<SkillId>(initial?.skill ?? 'LISTENING');
  const [track, setTrack] = useState<LearningTrack>(initial?.track ?? 'GENERAL_ENGLISH');
  const [primarySkill, setPrimarySkill] = useState<PrimarySkill>(
    initial?.primarySkill ?? 'LISTENING',
  );
  const [resourceId, setResourceId] = useState(initial?.resourceId ?? '');
  const [chapter, setChapter] = useState(initial?.chapter ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [plannedMinutes, setPlannedMinutes] = useState(initial?.plannedMinutes ?? 45);
  const [actualMinutes, setActualMinutes] = useState(initial?.actualMinutes ?? 45);
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? 'DONE');
  const [totalQuestions, setTotalQuestions] = useState(initial?.totalQuestions ?? 0);
  const [correctQuestions, setCorrectQuestions] = useState(initial?.correctQuestions ?? 0);
  const [difficulty, setDifficulty] = useState<Difficulty | ''>(initial?.difficulty ?? '');
  const [outputText, setOutputText] = useState(initial?.outputText ?? '');
  const [problemText, setProblemText] = useState(initial?.problemText ?? '');
  const [errorTypes, setErrorTypes] = useState<string[]>(initial?.errorTypes ?? []);
  const [nextReviewDate, setNextReviewDate] = useState(initial?.nextReviewDate ?? '');
  const [ext, setExt] = useState<ExtValues>((initial?.ext as ExtValues | undefined) ?? {});

  const accuracy = useMemo(
    () => accuracyOf(correctQuestions, totalQuestions),
    [correctQuestions, totalQuestions],
  );

  const toggleErrorType = (value: string) => {
    setErrorTypes((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value],
    );
  };

  const cleanExt = (): ExtValues => {
    const out: ExtValues = {};
    for (const [key, value] of Object.entries(ext)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      out[key] = typeof value === 'string' ? value.trim() : value;
    }
    return out;
  };

  const submit = () => {
    setFieldErrors({});
    const payload = {
      ...(mode === 'edit' && initial ? { id: initial.id } : {}),
      stageId,
      recordDate,
      skill,
      track,
      primarySkill,
      resourceId: resourceId || undefined,
      chapter: chapter || undefined,
      content: content.trim(),
      plannedMinutes,
      actualMinutes,
      status,
      totalQuestions,
      correctQuestions,
      difficulty: difficulty || undefined,
      outputText: outputText || undefined,
      problemText: problemText || undefined,
      errorTypes: errorTypes.length > 0 ? errorTypes : undefined,
      nextReviewDate: nextReviewDate || undefined,
      ext: cleanExt(),
    };

    startTransition(async () => {
      const result =
        mode === 'edit'
          ? await updateStudyRecordAction(payload)
          : await createStudyRecordAction(payload);
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(mode === 'edit' ? '记录已更新（改动已留痕）' : '记录已保存', 'success');
      const recordId = mode === 'edit' && initial ? initial.id : result.data.recordId;
      onSaved?.(recordId);
      router.refresh();
    });
  };

  if (stages.length === 0) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        还没有可用阶段。请先运行 seed 或到「阶段与验收」页创建阶段，记录必须挂在阶段上。
      </p>
    );
  }

  return (
    <Card
      title={mode === 'edit' ? '编辑学习记录' : '新建学习记录'}
      description="编辑不会改变创建时间，字段级改动会写入修订历史。"
      actions={
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : mode === 'edit' ? '保存修改' : '保存记录'}
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="日期" htmlFor="recordDate" required error={fieldErrors.recordDate}>
          <input
            id="recordDate"
            type="date"
            value={recordDate}
            onChange={(event) => setRecordDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="阶段" htmlFor="stageId" required error={fieldErrors.stageId}>
          <select
            id="stageId"
            value={stageId}
            onChange={(event) => setStageId(event.target.value)}
            className={selectClass}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.nameZh}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="轨道"
          htmlFor="track"
          required
          error={fieldErrors.track}
          hint={TRACK_SUBTITLE_ZH[track]}
        >
          <select
            id="track"
            value={track}
            onChange={(event) => setTrack(event.target.value as LearningTrack)}
            className={selectClass}
          >
            {LEARNING_TRACKS.map((item) => (
              <option key={item} value={item}>
                {TRACK_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="科目" htmlFor="skill" required error={fieldErrors.skill}>
          <select
            id="skill"
            value={skill}
            onChange={(event) => setSkill(event.target.value as SkillId)}
            className={selectClass}
          >
            {SKILL_IDS.map((item) => (
              <option key={item} value={item}>
                {SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="主要技能"
          htmlFor="primarySkill"
          required
          error={fieldErrors.primarySkill}
          hint="四技能参与配比分母；FOUNDATION 单独计，不进分母"
        >
          <select
            id="primarySkill"
            value={primarySkill}
            onChange={(event) => setPrimarySkill(event.target.value as PrimarySkill)}
            className={selectClass}
          >
            {PRIMARY_SKILLS.map((item) => (
              <option key={item} value={item}>
                {PRIMARY_SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="资源" htmlFor="resourceId" error={fieldErrors.resourceId}>
          <select
            id="resourceId"
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
            className={selectClass}
          >
            <option value="">未关联资源</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.isPrimary ? '★ ' : ''}
                {resource.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="章节 / 单元" htmlFor="chapter">
          <input
            id="chapter"
            type="text"
            value={chapter}
            onChange={(event) => setChapter(event.target.value)}
            placeholder="例如 Unit 12 / Reading Explorer 2-3"
            className={`${inputClass} w-full`}
          />
        </FormField>

        <FormField
          label="内容摘要"
          htmlFor="content"
          required
          className="sm:col-span-2 xl:col-span-3"
          error={fieldErrors.content}
        >
          <input
            id="content"
            type="text"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="今天具体做了什么"
            className={inputClass}
          />
        </FormField>

        <FormField label="计划时长（分钟）" htmlFor="plannedMinutes" error={fieldErrors.plannedMinutes}>
          <input
            id="plannedMinutes"
            type="number"
            min={0}
            max={600}
            value={plannedMinutes}
            onChange={(event) => setPlannedMinutes(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField label="实际时长（分钟）" htmlFor="actualMinutes" error={fieldErrors.actualMinutes}>
          <input
            id="actualMinutes"
            type="number"
            min={0}
            max={600}
            value={actualMinutes}
            onChange={(event) => setActualMinutes(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField label="状态" htmlFor="status" error={fieldErrors.status}>
          <select
            id="status"
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
            className={selectClass}
          >
            {TASK_STATUSES.map((item) => (
              <option key={item} value={item}>
                {TASK_STATUS_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="难度" htmlFor="difficulty">
          <select
            id="difficulty"
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value as Difficulty | '')}
            className={selectClass}
          >
            {DIFFICULTY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="总题数" htmlFor="totalQuestions" error={fieldErrors.totalQuestions}>
          <input
            id="totalQuestions"
            type="number"
            min={0}
            value={totalQuestions}
            onChange={(event) => setTotalQuestions(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField
          label="正确数"
          htmlFor="correctQuestions"
          error={fieldErrors.correctQuestions}
          hint="正确数不得大于总题数"
        >
          <input
            id="correctQuestions"
            type="number"
            min={0}
            max={totalQuestions}
            value={correctQuestions}
            onChange={(event) => setCorrectQuestions(Number(event.target.value))}
            className={inputClass}
          />
        </FormField>

        <FormField
          label="正确率（只读）"
          hint={totalQuestions > 0 ? 'correct / total' : '无题量数据'}
        >
          <div className="tabular rounded-md border border-line bg-surfaceAlt px-2.5 py-1.5 text-sm text-ink">
            {totalQuestions > 0 ? formatPercent(accuracy) : '无题量数据'}
          </div>
        </FormField>

        <FormField label="下次复习日期" htmlFor="nextReviewDate">
          <input
            id="nextReviewDate"
            type="date"
            value={nextReviewDate}
            onChange={(event) => setNextReviewDate(event.target.value)}
            className={inputClass}
          />
        </FormField>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <FormField
          label="产出（可检查结果）"
          htmlFor="outputText"
          error={fieldErrors.outputText}
          hint="与「问题」至少填一项；有正确率/录音链接/英文摘要也算有效产出"
        >
          <textarea
            id="outputText"
            value={outputText}
            onChange={(event) => setOutputText(event.target.value)}
            placeholder="写出来的句子 / 作文片段 / 摘要 / 录音链接说明"
            className={textareaClass}
          />
        </FormField>

        <FormField label="问题" htmlFor="problemText" error={fieldErrors.problemText}>
          <textarea
            id="problemText"
            value={problemText}
            onChange={(event) => setProblemText(event.target.value)}
            placeholder="卡在哪里、哪个规则没懂、哪句听不出来"
            className={textareaClass}
          />
        </FormField>
      </div>

      <FormField label="错误类型（多选）" className="mt-2">
        <div className="flex flex-wrap gap-1.5">
          {ERROR_CATEGORIES.map((category) => {
            const checked = errorTypes.includes(category);
            return (
              <label
                key={category}
                className={[
                  'cursor-pointer rounded border px-2 py-0.5 text-[11px]',
                  checked
                    ? 'border-brand bg-blue-50 text-brand'
                    : 'border-line bg-white text-inkMuted',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggleErrorType(category)}
                />
                {ERROR_CATEGORY_LABEL_ZH[category]}
              </label>
            );
          })}
        </div>
      </FormField>

      {hasExtFields(skill) && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold text-ink">
            {SKILL_LABEL_ZH[skill]} 扩展字段
          </p>
          <SkillExtFields skill={skill} values={ext} onChange={setExt} />
        </div>
      )}
    </Card>
  );
}
