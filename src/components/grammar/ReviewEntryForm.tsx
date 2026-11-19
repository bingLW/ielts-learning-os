'use client';

/**
 * 复测录入表单（T22 的落地核心）。
 *
 * 两段式：
 * 1. **即时预览**：调用与服务器完全相同的纯函数 `judgeEgiuColor`，
 *    让用户在提交前就看到「会判成什么色、为什么」，避免「提交了才知道结果」的焦虑；
 * 2. **服务端复判**：action 里再判一次并落库 —— 客户端结果永远只是预览，不是真值。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recordEgiuReviewAction } from '@/lib/actions/egiu';
import {
  COLOR_INTERVALS,
  EGIU_COLOR_LABEL_ZH,
  INTERVAL_LABEL_ZH,
  JUDGE_BRANCH_LABEL_ZH,
  REVIEW_STAGE_CODES,
  REVIEW_STAGE_LABEL_ZH,
} from '@/lib/constants';
import { judgeEgiuColor } from '@/lib/domain/color';
import { today } from '@/lib/date';
import type { ReviewStageCode } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { ColorBadge } from '@/components/ui/ColorBadge';
import { FormField, inputClass } from '@/components/ui/FormField';

export interface ReviewEntryFormProps {
  lessonId: string;
  defaultStage: ReviewStageCode;
  disabled?: boolean;
  onToast: (message: string, tone: 'success' | 'error') => void;
}

/** 数字输入 → 安全整数。 */
function toInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

export function ReviewEntryForm({
  lessonId,
  defaultStage,
  disabled = false,
  onToast,
}: ReviewEntryFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [reviewDate, setReviewDate] = useState(today());
  const [reviewStage, setReviewStage] = useState<ReviewStageCode>(defaultStage);
  const [total, setTotal] = useState('5');
  const [correct, setCorrect] = useState('4');
  const [explainOk, setExplainOk] = useState(false);
  const [sentences, setSentences] = useState('0');
  const [coreRuleOk, setCoreRuleOk] = useState(true);

  const [ruleUnclear, setRuleUnclear] = useState('0');
  const [memoryConfusion, setMemoryConfusion] = useState('0');
  const [careless, setCareless] = useState('0');
  const [vocab, setVocab] = useState('0');

  const preview = judgeEgiuColor({
    total: toInt(total),
    correct: toInt(correct),
    explainOK: explainOk,
    sentences: toInt(sentences),
    coreRuleOK: coreRuleOk,
  });

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await recordEgiuReviewAction({
        lessonId,
        reviewDate,
        reviewStage,
        totalQuestions: toInt(total),
        correctQuestions: toInt(correct),
        explainOk,
        sentencesCount: toInt(sentences),
        coreRuleOk,
        errorBreakdown: {
          rule_unclear: toInt(ruleUnclear),
          memory_confusion: toInt(memoryConfusion),
          careless: toInt(careless),
          vocab: toInt(vocab),
        },
      });

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }

      const { color, reason, plannedPoints, mastered } = result.data;
      const extra = plannedPoints.length > 0
        ? ` · 已生成 ${plannedPoints.length} 个复习点`
        : ' · 未生成新复习点';
      onToast(
        `判定：${EGIU_COLOR_LABEL_ZH[color]}（${reason}）${extra}${mastered ? ' · 已判定掌握' : ''}`,
        'success',
      );
      router.refresh();
    });
  };

  if (disabled) {
    return (
      <p className="rounded-md border border-line bg-surfaceAlt px-3 py-2 text-xs text-inkMuted">
        当前阶段不启用 EGIU 判定，表单已禁用。切换到「阶段一 / 阶段二」后再录入。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
        <FormField label="复测日期" htmlFor="egiu-date" required error={fieldErrors.reviewDate}>
          <input
            id="egiu-date"
            type="date"
            value={reviewDate}
            onChange={(event) => setReviewDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField
          label="档位"
          htmlFor="egiu-stage"
          required
          hint="D0 = 首测；其余为间隔复测"
          error={fieldErrors.reviewStage}
        >
          <select
            id="egiu-stage"
            value={reviewStage}
            onChange={(event) => setReviewStage(event.target.value as ReviewStageCode)}
            className={inputClass}
          >
            {REVIEW_STAGE_CODES.map((code) => (
              <option key={code} value={code}>
                {REVIEW_STAGE_LABEL_ZH[code]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="总题数"
          htmlFor="egiu-total"
          required
          hint="≥5 才按正确率直接判色"
          error={fieldErrors.totalQuestions}
        >
          <input
            id="egiu-total"
            type="number"
            min={0}
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="正确题数" htmlFor="egiu-correct" required error={fieldErrors.correctQuestions}>
          <input
            id="egiu-correct"
            type="number"
            min={0}
            value={correct}
            onChange={(event) => setCorrect(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="能讲清规则" htmlFor="egiu-explain" hint="口头/书面解释核心规则">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              id="egiu-explain"
              type="checkbox"
              checked={explainOk}
              onChange={(event) => setExplainOk(event.target.checked)}
            />
            能说清
          </label>
        </FormField>

        <FormField label="独立造句数" htmlFor="egiu-sentences" hint="正确、且是新造的句子">
          <input
            id="egiu-sentences"
            type="number"
            min={0}
            value={sentences}
            onChange={(event) => setSentences(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <FormField label="理解核心规则" htmlFor="egiu-core" hint="取消勾选 = 硬否决，直接红灯">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              id="egiu-core"
              type="checkbox"
              checked={coreRuleOk}
              onChange={(event) => setCoreRuleOk(event.target.checked)}
            />
            已理解
          </label>
        </FormField>
      </div>

      <div className="rounded-md border border-line bg-surfaceAlt px-3 py-2">
        <p className="mb-1 text-[11px] font-semibold text-inkMuted">判定预览（与服务器同一份规则）</p>
        {preview.ok ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ColorBadge color={preview.judgment.color} score={preview.judgment.score} />
              <span className="text-[11px] text-inkMuted">
                分支：{JUDGE_BRANCH_LABEL_ZH[preview.judgment.branch]}
              </span>
            </div>
            <p className="text-xs text-ink">{preview.judgment.reason}</p>
            <p className="text-[11px] text-inkMuted">
              将生成的复习档位：
              {COLOR_INTERVALS[preview.judgment.color].length === 0
                ? '无（绿灯不进结构化复习）'
                : COLOR_INTERVALS[preview.judgment.color]
                    .map((code) => INTERVAL_LABEL_ZH[code])
                    .join(' / ')}
            </p>
          </div>
        ) : (
          <p className="text-xs text-red-700">
            输入不合法：
            {preview.code === 'CORRECT_GT_TOTAL' ? '正确题数不能大于总题数' : '题量/句子数不能为负'}
          </p>
        )}
      </div>

      <details className="rounded-md border border-line bg-white px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium text-ink">
          错因分布（可选，用于薄弱点排序）
        </summary>
        <div className="mt-2 grid gap-2 mobile:grid-cols-2 md:grid-cols-4">
          <FormField label="规则不清" htmlFor="egiu-err-rule">
            <input
              id="egiu-err-rule"
              type="number"
              min={0}
              value={ruleUnclear}
              onChange={(event) => setRuleUnclear(event.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label="记忆混淆" htmlFor="egiu-err-memory">
            <input
              id="egiu-err-memory"
              type="number"
              min={0}
              value={memoryConfusion}
              onChange={(event) => setMemoryConfusion(event.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label="粗心" htmlFor="egiu-err-careless">
            <input
              id="egiu-err-careless"
              type="number"
              min={0}
              value={careless}
              onChange={(event) => setCareless(event.target.value)}
              className={inputClass}
            />
          </FormField>
          <FormField label="词汇不认识" htmlFor="egiu-err-vocab">
            <input
              id="egiu-err-vocab"
              type="number"
              min={0}
              value={vocab}
              onChange={(event) => setVocab(event.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '提交中…' : '提交复测（append-only）'}
        </Button>
        <span className="text-[11px] text-inkMuted">
          复测记录只增不改：录错了只能再追加一条更正记录。
        </span>
      </div>
    </div>
  );
}
