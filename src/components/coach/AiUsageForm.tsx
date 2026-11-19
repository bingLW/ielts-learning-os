'use client';

/**
 * AI 使用日志录入。
 *
 * 记录的是「用了哪一层支架、输出是否采纳」，不上传对话原文。
 */

import { useState, useTransition } from 'react';
import { createAiUsageAction } from '@/lib/actions/aiUsage';
import {
  ADOPTION_STATUSES,
  ADOPTION_STATUS_LABEL_ZH,
  AI_ACTION_TYPES,
  AI_ACTION_TYPE_LABEL_ZH,
  AI_SUBSTITUTE_ASSISTANCE_LEVEL,
  ASSISTANCE_LEVELS,
  ASSISTANCE_LEVEL_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { aiLevelAllowedForAction } from '@/lib/domain/coach';
import type { EvidencePickerOption } from '@/lib/queries/evidence';
import type { AdoptionStatus, AIActionType, AssistanceLevel } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface AiUsageFormProps {
  options: EvidencePickerOption[];
  onSaved: () => void;
  onCancel: () => void;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

export function AiUsageForm({ options, onSaved, onCancel, onToast }: AiUsageFormProps) {
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [toolName, setToolName] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [level, setLevel] = useState<AssistanceLevel>('A1');
  const [actionType, setActionType] = useState<AIActionType>('HINT');
  const [purpose, setPurpose] = useState('');
  const [inputRef, setInputRef] = useState('');
  const [outputRef, setOutputRef] = useState('');
  const [adopted, setAdopted] = useState<AdoptionStatus>('PARTIAL');
  const [evidenceId, setEvidenceId] = useState('');

  const levelCheck = aiLevelAllowedForAction(level, actionType);
  const isSubstitute = level === AI_SUBSTITUTE_ASSISTANCE_LEVEL;

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await createAiUsageAction({
        toolName,
        modelVersion: modelVersion || undefined,
        assistanceLevel: level,
        actionType,
        purpose: purpose || undefined,
        inputRef: inputRef || undefined,
        outputRef: outputRef || undefined,
        adoptedOrRejected: adopted,
        evidenceId: evidenceId || undefined,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('AI 使用已记录', 'success');
      onSaved();
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="工具名称" htmlFor="ai-tool" required error={fieldErrors.toolName}>
          <input
            id="ai-tool"
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            className={inputClass}
            placeholder="例：ChatGPT / Claude / 词典内置 AI"
          />
        </FormField>

        <FormField label="模型/版本（可选）" htmlFor="ai-model">
          <input
            id="ai-model"
            value={modelVersion}
            onChange={(event) => setModelVersion(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="辅助级别" htmlFor="ai-level" required error={fieldErrors.assistanceLevel}>
          <select
            id="ai-level"
            value={level}
            onChange={(event) => setLevel(event.target.value as AssistanceLevel)}
            className={selectClass}
          >
            {ASSISTANCE_LEVELS.map((item) => (
              <option key={item} value={item}>
                {ASSISTANCE_LEVEL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="使用类型" htmlFor="ai-action" required error={fieldErrors.actionType}>
          <select
            id="ai-action"
            value={actionType}
            onChange={(event) => setActionType(event.target.value as AIActionType)}
            className={selectClass}
          >
            {AI_ACTION_TYPES.map((item) => (
              <option key={item} value={item}>
                {AI_ACTION_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="采纳情况" htmlFor="ai-adopted" required>
          <select
            id="ai-adopted"
            value={adopted}
            onChange={(event) => setAdopted(event.target.value as AdoptionStatus)}
            className={selectClass}
          >
            {ADOPTION_STATUSES.map((item) => (
              <option key={item} value={item}>
                {ADOPTION_STATUS_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="关联证据（可选）" htmlFor="ai-evidence" error={fieldErrors.evidenceId}>
          <select
            id="ai-evidence"
            value={evidenceId}
            onChange={(event) => setEvidenceId(event.target.value)}
            className={selectClass}
          >
            <option value="">不关联</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {EVIDENCE_SKILL_LABEL_ZH[option.skill]} ·{' '}
                {LEARNING_EVIDENCE_TYPE_CODE[option.evidenceType]}{' '}
                {LEARNING_EVIDENCE_TYPE_LABEL_ZH[option.evidenceType]}
                {option.independent ? ' · 独立' : ' · 辅助'}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="用途" htmlFor="ai-purpose" className="sm:col-span-2">
          <input
            id="ai-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            className={inputClass}
            placeholder="例：请它只给一个提示，不直接改写"
          />
        </FormField>

        <FormField label="输入引用" htmlFor="ai-input" className="sm:col-span-2">
          <textarea
            id="ai-input"
            value={inputRef}
            onChange={(event) => setInputRef(event.target.value)}
            className={textareaClass}
            placeholder="粘贴的题目/材料简述或链接；不需要上传原文全文"
          />
        </FormField>

        <FormField label="输出引用" htmlFor="ai-output" className="sm:col-span-2">
          <textarea
            id="ai-output"
            value={outputRef}
            onChange={(event) => setOutputRef(event.target.value)}
            className={textareaClass}
            placeholder="它给了什么（简述）；采纳了多少"
          />
        </FormField>
      </div>

      {!levelCheck.ok && (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
          {levelCheck.error}
        </p>
      )}
      {isSubstitute && (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-900">
          A4 是代写/代答：这条记录永远不会被计为你的独立产出，也不能直接生成独立证据。
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending || !levelCheck.ok}>
          <Icon name="check" size={14} />
          {pending ? '保存中…' : '记录 AI 使用'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
