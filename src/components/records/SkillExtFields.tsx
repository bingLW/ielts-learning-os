'use client';

/**
 * 分科扩展字段（听力 7 / 阅读 7 / 口语 8 / 写作 9）。
 *
 * 字段名沿用 PRD §7 的 `study_record.ext` 键名（snake_case），因为它们是**数据契约**，
 * 后续导出与统计会按这些键取值（例如 `recording_url` 参与「有效产出」判定）。
 * 数组型字段（grammar_errors / pronunciation_issues）以逗号分隔的字符串存，
 * 保持 `ext` 只含可 JSON 化的标量。
 */

import type { SkillId } from '@/lib/types';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';

type ExtFieldType = 'text' | 'number' | 'textarea' | 'checkbox';

interface ExtFieldSpec {
  key: string;
  label: string;
  type: ExtFieldType;
  placeholder?: string;
  hint?: string;
}

const EXT_FIELDS: Partial<Record<SkillId, ExtFieldSpec[]>> = {
  LISTENING: [
    { key: 'audio_name', label: '音频名称', type: 'text', placeholder: '例如 BBC 6 Minute English #1201' },
    { key: 'audio_minutes', label: '音频时长（分钟）', type: 'number' },
    { key: 'gist_blind', label: '盲听主旨（不暂停）', type: 'textarea', placeholder: '一句话写清这段讲了什么' },
    { key: 'key_info', label: '关键信息', type: 'textarea', placeholder: '数字、人名、转折' },
    { key: 'unclear_segments', label: '听不清片段', type: 'textarea', placeholder: '按时间点记，便于回听' },
    { key: 'shadowing_done', label: '完成跟读', type: 'checkbox' },
    { key: 'retell_points_zh', label: '复述要点', type: 'textarea' },
  ],
  READING: [
    { key: 'article_name', label: '文章名称', type: 'text' },
    { key: 'word_count', label: '词数', type: 'number' },
    { key: 'pages', label: '页数', type: 'number' },
    { key: 'new_word_count', label: '生词数', type: 'number' },
    { key: 'gist', label: '主旨', type: 'textarea' },
    { key: 'comprehension_accuracy', label: '理解率（0–1）', type: 'number', hint: '例如 0.75' },
    { key: 'summary_en', label: '英文摘要', type: 'textarea', hint: '≥1 句即计入「有效产出」' },
  ],
  SPEAKING: [
    { key: 'topic', label: '话题', type: 'text' },
    { key: 'recording_minutes', label: '录音时长（分钟）', type: 'number' },
    { key: 'shadowing_count', label: '跟读次数', type: 'number' },
    { key: 'independent_speech_minutes', label: '独立表达（分钟）', type: 'number' },
    { key: 'grammar_errors', label: '语法错误（逗号分隔）', type: 'text' },
    { key: 'pronunciation_issues', label: '发音问题（逗号分隔）', type: 'text' },
    { key: 'pause_count', label: '停顿次数', type: 'number' },
    { key: 'recording_url', label: '录音链接', type: 'text', placeholder: '本地路径或链接' },
  ],
  WRITING: [
    { key: 'topic', label: '题目/话题', type: 'text' },
    {
      key: 'task_type',
      label: '写作类型',
      type: 'text',
      placeholder: 'SENTENCE / DIARY / PARAGRAPH / ESSAY_150_200 / TASK1 / TASK2',
    },
    { key: 'word_count', label: '词数', type: 'number' },
    { key: 'time_spent_min', label: '用时（分钟）', type: 'number' },
    { key: 'grammar_error_count', label: '语法错误数', type: 'number' },
    { key: 'spelling_error_count', label: '拼写错误数', type: 'number' },
    { key: 'revised', label: '已修改', type: 'checkbox' },
    { key: 'draft_text', label: '初稿', type: 'textarea' },
    { key: 'revised_text', label: '修改稿', type: 'textarea' },
  ],
};

export type ExtValues = Record<string, string | number | boolean | null>;

/** 该科目是否有扩展字段。 */
export function hasExtFields(skill: SkillId): boolean {
  return (EXT_FIELDS[skill]?.length ?? 0) > 0;
}

export function SkillExtFields({
  skill,
  values,
  onChange,
}: {
  skill: SkillId;
  values: ExtValues;
  onChange: (next: ExtValues) => void;
}) {
  const fields = EXT_FIELDS[skill];
  if (!fields || fields.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-2 text-[11px] text-inkMuted">
        该科目没有分科扩展字段（扩展仅覆盖听力 / 阅读 / 口语 / 写作）。
      </p>
    );
  }

  const setValue = (key: string, value: string | number | boolean | null) => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => {
        const id = `ext-${field.key}`;
        if (field.type === 'checkbox') {
          const checked = values[field.key] === true;
          return (
            <FormField key={field.key} label={field.label} htmlFor={id} hint={field.hint}>
              <label className="flex items-center gap-1.5 text-xs text-ink">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setValue(field.key, event.target.checked)}
                  className="h-3.5 w-3.5"
                />
                {checked ? '已完成' : '未完成'}
              </label>
            </FormField>
          );
        }
        if (field.type === 'textarea') {
          return (
            <FormField key={field.key} label={field.label} htmlFor={id} hint={field.hint} className="sm:col-span-2">
              <textarea
                id={id}
                value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
                placeholder={field.placeholder}
                onChange={(event) => setValue(field.key, event.target.value)}
                className={textareaClass}
              />
            </FormField>
          );
        }
        return (
          <FormField key={field.key} label={field.label} htmlFor={id} hint={field.hint}>
            <input
              id={id}
              type={field.type === 'number' ? 'number' : 'text'}
              step={field.type === 'number' ? 'any' : undefined}
              value={
                field.type === 'number'
                  ? typeof values[field.key] === 'number'
                    ? (values[field.key] as number)
                    : ''
                  : typeof values[field.key] === 'string'
                    ? (values[field.key] as string)
                    : ''
              }
              placeholder={field.placeholder}
              onChange={(event) =>
                setValue(
                  field.key,
                  field.type === 'number'
                    ? event.target.value === ''
                      ? null
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
              className={inputClass}
            />
          </FormField>
        );
      })}
    </div>
  );
}
