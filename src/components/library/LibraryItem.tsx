'use client';

/**
 * 方法论资料库的一行：元数据 + 许可 + 阅读日志编辑。
 *
 * 打开原站在新标签页；页面内不展示原站正文，只展示我们自己的摘要。
 */

import { useState, useTransition } from 'react';
import { updateReadingLogAction } from '@/lib/actions/library';
import {
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  LIBRARY_RESOURCE_TYPE_LABEL_ZH,
  METHODOLOGY_CATEGORY_LABEL_ZH,
  RESOURCE_READ_STATUS_LABEL_ZH,
  RESOURCE_READ_STATUSES,
  RESOURCE_PRIORITY_LABEL_ZH,
  STAGE_PROFILE_LABEL_ZH,
  type LibraryResourceType,
} from '@/lib/constants';
import type {
  LibraryEvidenceOptionDto,
  MethodologyCategory,
  MethodologyResourceDto,
  ResourceReadStatus,
  StageProfileCode,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { TagBadge } from '@/components/ui/StatusBadge';

const READ_STATUS_CLASS: Record<ResourceReadStatus, string> = {
  NOT_STARTED: 'bg-slate-100 text-slate-700 border-slate-300',
  READING: 'bg-blue-50 text-blue-700 border-blue-300',
  SUMMARIZED: 'bg-indigo-50 text-indigo-700 border-indigo-300',
  APPLIED: 'bg-amber-50 text-amber-800 border-amber-300',
  DONE: 'bg-emerald-50 text-emerald-700 border-emerald-300',
};

function ReadStatusBadge({ status }: { status: ResourceReadStatus }) {
  return (
    <span
      title={status}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${READ_STATUS_CLASS[status]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {RESOURCE_READ_STATUS_LABEL_ZH[status]}
    </span>
  );
}

export interface LibraryItemProps {
  resource: MethodologyResourceDto;
  evidenceOptions: LibraryEvidenceOptionDto[];
  onToast: (message: string, tone: 'success' | 'error') => void;
  onSaved: () => void;
}

export function LibraryItem({ resource, evidenceOptions, onToast, onSaved }: LibraryItemProps) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const currentStatus: ResourceReadStatus = resource.reading?.status ?? 'NOT_STARTED';
  const [status, setStatus] = useState<ResourceReadStatus>(currentStatus);
  const [summary, setSummary] = useState(resource.reading?.personalSummary ?? '');
  const [action, setAction] = useState(resource.reading?.plannedAction ?? '');
  const [evidenceId, setEvidenceId] = useState(resource.reading?.appliedEvidenceId ?? '');

  const openEditor = () => {
    setStatus(resource.reading?.status ?? 'READING');
    setSummary(resource.reading?.personalSummary ?? '');
    setAction(resource.reading?.plannedAction ?? '');
    setEvidenceId(resource.reading?.appliedEvidenceId ?? '');
    setFieldErrors({});
    setEditing(true);
  };

  const save = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateReadingLogAction({
        resourceId: resource.id,
        status,
        personalSummary: summary || undefined,
        plannedAction: action || undefined,
        appliedEvidenceId: evidenceId || undefined,
      });
      if (!result.ok) {
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        onToast(result.error, 'error');
        return;
      }
      setEditing(false);
      onToast(`已更新「${resource.title}」的阅读进度`, 'success');
      onSaved();
    });
  };

  const categoryLabel = resource.category
    ? (METHODOLOGY_CATEGORY_LABEL_ZH[resource.category as MethodologyCategory] ?? resource.category)
    : '未分类';
  const typeLabel =
    LIBRARY_RESOURCE_TYPE_LABEL_ZH[resource.resourceType as LibraryResourceType] ??
    resource.resourceType;

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink">{resource.title}</span>
            <TagBadge
              tone={resource.priority === 'P0' ? 'warn' : resource.priority === 'P1' ? 'info' : 'neutral'}
            >
              {RESOURCE_PRIORITY_LABEL_ZH[resource.priority]}
            </TagBadge>
            <TagBadge>{categoryLabel}</TagBadge>
            <TagBadge>{typeLabel}</TagBadge>
          </div>
          <p className="mt-0.5 text-[11px] text-inkMuted">
            {resource.creator ?? '作者未标注'}
            {resource.stageFit.length > 0 &&
              ` · 适用阶段：${resource.stageFit
                .map((code) => STAGE_PROFILE_LABEL_ZH[code as StageProfileCode] ?? code)
                .join('/')}`}
            {resource.reading?.lastReadAt ? ` · 最近记录 ${resource.reading.lastReadAt}` : ''}
          </p>
          {resource.summary && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink">{resource.summary}</p>
          )}
          {resource.reading?.personalSummary && (
            <p className="mt-1 rounded border border-line bg-surfaceAlt px-2 py-1 text-[11px] text-ink">
              我的摘要：{resource.reading.personalSummary}
            </p>
          )}
          {resource.reading?.plannedAction && (
            <p className="mt-1 text-[11px] text-inkMuted">实践：{resource.reading.plannedAction}</p>
          )}
          <p className="mt-1 text-[10px] text-inkMuted">许可：{resource.licenseNote ?? '以原站声明为准'}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ReadStatusBadge status={currentStatus} />
          <a
            href={resource.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-brand underline-offset-2 hover:underline"
          >
            打开原站 ↗
          </a>
          {!editing && (
            <Button variant="secondary" size="sm" onClick={openEditor}>
              {currentStatus === 'NOT_STARTED' ? '记录进度' : '更新进度'}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 space-y-2 rounded-md border border-line bg-surfaceAlt/60 p-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <FormField label="阅读状态" htmlFor={`status-${resource.id}`} error={fieldErrors.status}>
              <select
                id={`status-${resource.id}`}
                className={selectClass}
                value={status}
                onChange={(event) => setStatus(event.target.value as ResourceReadStatus)}
              >
                {RESOURCE_READ_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {RESOURCE_READ_STATUS_LABEL_ZH[item]}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="关联证据（可选）"
              htmlFor={`evidence-${resource.id}`}
              hint="只有真正做过实践才需要关联；A0 独立证据优先。"
              error={fieldErrors.appliedEvidenceId}
            >
              <select
                id={`evidence-${resource.id}`}
                className={selectClass}
                value={evidenceId}
                onChange={(event) => setEvidenceId(event.target.value)}
              >
                <option value="">不关联</option>
                {evidenceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.businessDate} · {EVIDENCE_SKILL_LABEL_ZH[option.skill]} ·{' '}
                    {LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]} · {option.preview}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <FormField
            label="个人摘要（≥20 字，不复制原文）"
            htmlFor={`summary-${resource.id}`}
            error={fieldErrors.personalSummary}
          >
            <textarea
              id={`summary-${resource.id}`}
              className={textareaClass}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="用你自己的话写：这份方法论解决什么问题、你准备怎么用。"
            />
          </FormField>
          <FormField
            label="实践计划 / 实际动作"
            htmlFor={`action-${resource.id}`}
            hint="例如：用 Phrasebank 的让步结构写 3 句 Task 2 主体句。"
            error={fieldErrors.plannedAction}
          >
            <input
              id={`action-${resource.id}`}
              className={inputClass}
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="标记「已实践」或「已完成」时必填"
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" disabled={pending} onClick={save}>
              {pending ? '保存中…' : '保存阅读日志'}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
