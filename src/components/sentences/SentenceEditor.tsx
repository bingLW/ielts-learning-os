'use client';

/**
 * 句子成分编辑器（T27）。
 *
 * 交互：粘贴句子 → 「拆分」得到 token → 每个 token 两列独立选择
 * （句子成分 / 词性）。两个选择器各自的取值集合不同，界面上一眼能看出是两件事。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSentenceAction } from '@/lib/actions/sentences';
import {
  PARTS_OF_SPEECH,
  PART_OF_SPEECH_LABEL_ZH,
  PATTERN_TAG_LABEL_ZH,
  SENTENCE_COMPONENTS,
  SENTENCE_COMPONENT_LABEL_ZH,
  SENTENCE_ERROR_REASON_MIN,
  SENTENCE_MAX_TOKENS,
} from '@/lib/constants';
import { useBusinessToday } from '@/components/layout/BusinessTimeProvider';
import { annotationProgress, createTokens, validateTokens } from '@/lib/domain/sentence';
import type {
  PartOfSpeech,
  PatternTag,
  SentenceComponent,
  SentenceTokenDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';

export interface SentenceEditorProps {
  stages: { id: string; nameZh: string }[];
  defaultStageId: string | null;
  /** 当前阶段建议启用的句型标签。 */
  stageTags: readonly PatternTag[];
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function SentenceEditor({
  stages,
  defaultStageId,
  stageTags,
  onToast,
  onDone,
}: SentenceEditorProps) {
  const businessDate = useBusinessToday();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [stageId, setStageId] = useState(defaultStageId ?? stages[0]?.id ?? '');
  const [sentenceEn, setSentenceEn] = useState('');
  const [sentenceZh, setSentenceZh] = useState('');
  const [tokens, setTokens] = useState<SentenceTokenDto[]>([]);
  const [isCorrect, setIsCorrect] = useState(true);
  const [errorReason, setErrorReason] = useState('');
  const [patternTag, setPatternTag] = useState<PatternTag | ''>('');
  const [sentenceDate, setSentenceDate] = useState(businessDate);

  const progress = annotationProgress(tokens);

  const split = () => {
    setTokens(createTokens(sentenceEn));
  };

  const patchToken = (index: number, patch: Partial<SentenceTokenDto>) => {
    setTokens((current) =>
      current.map((token, position) => (position === index ? { ...token, ...patch } : token)),
    );
  };

  const submit = () => {
    setFieldErrors({});
    const validation = validateTokens(tokens);
    if (!validation.ok) {
      onToast(validation.message, 'error');
      return;
    }
    if (!isCorrect && errorReason.trim().length < SENTENCE_ERROR_REASON_MIN) {
      onToast('标为「标错」时必须写清错在哪', 'error');
      return;
    }

    startTransition(async () => {
      const result = await createSentenceAction({
        stageId,
        sentenceEn,
        sentenceZh: sentenceZh || undefined,
        tokens: tokens.map((token) => ({
          text: token.text,
          component: token.component ?? '',
          pos: token.pos ?? '',
        })),
        isCorrect,
        errorReason: errorReason || undefined,
        patternTag: patternTag || undefined,
        sentenceDate,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast('句子分析已保存', 'success');
      onDone();
      router.refresh();
    });
  };

  return (
    <Card
      title="分析一个句子"
      description={`最多 ${SENTENCE_MAX_TOKENS} 个 token；成分与词性各自独立标注，不要求都填`}
    >
      <div className="grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
        <FormField label="阶段" htmlFor="st-stage" required error={fieldErrors.stageId}>
          <select
            id="st-stage"
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
        <FormField label="句子日期" htmlFor="st-date" required error={fieldErrors.sentenceDate}>
          <input
            id="st-date"
            type="date"
            value={sentenceDate}
            onChange={(event) => setSentenceDate(event.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label="句型标签" htmlFor="st-pattern" hint="只列出当前阶段的重点句型">
          <select
            id="st-pattern"
            value={patternTag}
            onChange={(event) => setPatternTag(event.target.value as PatternTag | '')}
            className={inputClass}
          >
            <option value="">不填</option>
            {stageTags.map((tag) => (
              <option key={tag} value={tag}>
                {PATTERN_TAG_LABEL_ZH[tag]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="是否标对" htmlFor="st-correct">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              id="st-correct"
              type="checkbox"
              checked={isCorrect}
              onChange={(event) => setIsCorrect(event.target.checked)}
            />
            我判断自己标对了
          </label>
        </FormField>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <FormField label="英文句子" htmlFor="st-en" required error={fieldErrors.sentenceEn}>
          <textarea
            id="st-en"
            value={sentenceEn}
            onChange={(event) => setSentenceEn(event.target.value)}
            className={textareaClass}
            placeholder="The book that I bought yesterday was written by a professor."
          />
        </FormField>
        <FormField label="中文释义（可选）" htmlFor="st-zh" error={fieldErrors.sentenceZh}>
          <textarea
            id="st-zh"
            value={sentenceZh}
            onChange={(event) => setSentenceZh(event.target.value)}
            className={textareaClass}
          />
        </FormField>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={split} disabled={sentenceEn.trim() === ''}>
          拆分为 token
        </Button>
        <span className="text-[11px] text-inkMuted">
          共 {progress.total} 个 token · 已标成分 {progress.componentAnnotated} · 已标词性{' '}
          {progress.posAnnotated}
        </span>
      </div>

      {tokens.length > 0 && (
        <div className="mt-2 overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[11px] text-inkMuted">
                <th className="py-1.5 pl-2 pr-2 font-medium">#</th>
                <th className="py-1.5 pr-2 font-medium">token</th>
                <th className="py-1.5 pr-2 font-medium">句子成分</th>
                <th className="py-1.5 pr-2 font-medium">词性</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token, index) => (
                <tr key={`${token.text}-${index}`} className="border-b border-line">
                  <td className="tabular py-1 pl-2 pr-2 text-[11px] text-inkMuted">{index + 1}</td>
                  <td className="py-1 pr-2 font-medium text-ink">{token.text}</td>
                  <td className="py-1 pr-2">
                    <select
                      value={token.component ?? ''}
                      onChange={(event) =>
                        patchToken(index, {
                          component:
                            event.target.value === ''
                              ? null
                              : (event.target.value as SentenceComponent),
                        })
                      }
                      aria-label={`${token.text} 的句子成分`}
                      className="w-full rounded border border-line bg-white px-1.5 py-0.5 text-[11px]"
                    >
                      <option value="">未标注</option>
                      {SENTENCE_COMPONENTS.map((component) => (
                        <option key={component} value={component}>
                          {SENTENCE_COMPONENT_LABEL_ZH[component]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      value={token.pos ?? ''}
                      onChange={(event) =>
                        patchToken(index, {
                          pos: event.target.value === '' ? null : (event.target.value as PartOfSpeech),
                        })
                      }
                      aria-label={`${token.text} 的词性`}
                      className="w-full rounded border border-line bg-white px-1.5 py-0.5 text-[11px]"
                    >
                      <option value="">未标注</option>
                      {PARTS_OF_SPEECH.map((pos) => (
                        <option key={pos} value={pos}>
                          {PART_OF_SPEECH_LABEL_ZH[pos]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isCorrect && (
        <div className="mt-2">
          <FormField
            label="错在哪里（必填）"
            htmlFor="st-error"
            required
            error={fieldErrors.errorReason}
          >
            <input
              id="st-error"
              value={errorReason}
              onChange={(event) => setErrorReason(event.target.value)}
              placeholder="例如：把 that 引导的定语从句当成了宾语从句"
              className={inputClass}
            />
          </FormField>
        </div>
      )}

      <div className="mt-3 flex gap-1.5">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : '保存分析'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
      </div>
    </Card>
  );
}
