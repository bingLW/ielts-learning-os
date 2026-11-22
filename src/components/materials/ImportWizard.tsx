'use client';

/**
 * 导入向导（4 步）：选内容 → 填来源权限 → 确认限制与告知 → 提交。
 *
 * 为什么做成分步而不是一屏长表单：权利确认与来源是**产品承诺**（PRD A-01/A-05），
 * 必须让用户逐项看到并主动勾选，而不是滚动到底顺手点提交。
 *
 * 提交路径有两条，服务端最终落到同一个 `finalizeMaterialUpload`：
 * - 粘贴 → `importPastedExcerptAction`（Server Action，免构造 FormData）
 * - 文件 → `POST /api/upload-material`（FormData，大文件由 Route Handler 处理）
 */

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import {
  confirmDuplicateChoiceAction,
  importPastedExcerptAction,
} from '@/lib/actions/materials';
import type { ImportContextDto } from '@/lib/queries/materials';
import { ImportStepFile } from './ImportStepFile';
import { ImportStepNotice } from './ImportStepNotice';
import { ImportStepSource } from './ImportStepSource';
import { ImportStepSubmit, type DuplicatePrompt } from './ImportStepSubmit';
import { EMPTY_SOURCE_DRAFT, type ImportDraft, type ImportMode, type SourceDraft } from './importTypes';

const STEP_TITLES = ['选择内容', '来源与权限', '限制与告知', '确认导入'] as const;

export function ImportWizard({ context }: { context: ImportContextDto }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();

  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<ImportMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [title, setTitle] = useState('');
  const [source, setSource] = useState<SourceDraft>(EMPTY_SOURCE_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicatePrompt | null>(null);

  const draft: ImportDraft = useMemo(
    () => ({ mode, file, pastedText, title, source }),
    [mode, file, pastedText, title, source],
  );

  const restricted = useMemo(() => {
    const item = context.sourceTypes.find((entry) => entry.value === source.sourceType);
    return item?.restricted === true;
  }, [context.sourceTypes, source.sourceType]);

  /** 逐步校验（真正的强校验在服务端 zod，这里只是别让用户白填）。 */
  const validate = useCallback(
    (current: number): boolean => {
      const next: Record<string, string> = {};
      if (current === 0) {
        if (mode === 'file' && !file) next.file = '请选择要导入的文件';
        if (mode === 'paste') {
          const text = pastedText.trim();
          if (!text) next.text = '请粘贴一段文本';
          else if (text.length > context.limits.maxPastedChars) {
            next.text = `粘贴内容不能超过 ${context.limits.maxPastedChars} 字符`;
          }
        }
      }
      if (current === 1) {
        const selected = context.sourceTypes.find((item) => item.value === source.sourceType);
        if (selected?.requiresUrl && !/^https?:\/\//i.test(source.url.trim())) {
          next.url = '请填写以 http(s):// 开头的链接';
        }
        if (selected?.requiresLicenseName && !source.licenseName.trim()) {
          next.licenseName = '开放许可必须填写许可名称';
        }
        if (source.licenseUrl.trim() && !/^https?:\/\//i.test(source.licenseUrl.trim())) {
          next.licenseUrl = '许可链接必须以 http(s):// 开头';
        }
        if (source.publishedYear.trim()) {
          const year = Number(source.publishedYear);
          if (!Number.isInteger(year) || year < 1000 || year > 2100) {
            next.publishedYear = '年份需在 1000–2100 之间';
          }
        }
      }
      if (current === 2 && !source.rightsConfirmed) {
        next.rightsConfirmed = '必须勾选确认后才能继续';
      }
      setErrors(next);
      return Object.keys(next).length === 0;
    },
    [context.limits.maxPastedChars, context.sourceTypes, file, mode, pastedText, source],
  );

  const goNext = (): void => {
    if (!validate(step)) return;
    setStep((current) => Math.min(STEP_TITLES.length - 1, current + 1));
  };

  const goBack = (): void => {
    setSubmitError(null);
    setStep((current) => Math.max(0, current - 1));
  };

  /** 组装 `source`（空串转 undefined，年份转数字）。 */
  const buildSource = useCallback(
    () => ({
      sourceType: source.sourceType,
      url: source.url.trim() || undefined,
      author: source.author.trim() || undefined,
      publisher: source.publisher.trim() || undefined,
      publishedYear: source.publishedYear.trim() ? Number(source.publishedYear) : undefined,
      licenseName: source.licenseName.trim() || undefined,
      licenseUrl: source.licenseUrl.trim() || undefined,
      userNote: source.userNote.trim() || undefined,
      rightsConfirmed: true,
    }),
    [source],
  );

  const submit = async (): Promise<void> => {
    if (!validate(2)) {
      setStep(2);
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      if (mode === 'paste') {
        const result = await importPastedExcerptAction({
          title: title.trim() || undefined,
          text: pastedText,
          source: buildSource(),
        });
        if (!result.ok) {
          setErrors(result.fieldErrors ?? {});
          setSubmitError(result.error);
          return;
        }
        if (result.data.duplicateOf) {
          setDuplicate({
            materialId: result.data.duplicateOf,
            contentHash: result.data.contentHash,
          });
          return;
        }
        goProcessing(result.data.materialId);
        return;
      }

      const formData = new FormData();
      if (file) formData.set('file', file);
      formData.set(
        'meta',
        JSON.stringify({
          title: title.trim(),
          source: buildSource(),
        }),
      );

      const response = await fetch('/api/upload-material', { method: 'POST', body: formData });
      const payload = (await response.json()) as
        | { ok: true; data: { materialId: string; contentHash: string; duplicateOf?: string } }
        | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> };

      if (!response.ok || !payload.ok) {
        const message = 'error' in payload ? payload.error : '导入失败，请稍后重试';
        if ('fieldErrors' in payload && payload.fieldErrors) setErrors(payload.fieldErrors);
        setSubmitError(message);
        show(message, 'error');
        return;
      }

      if (payload.data.duplicateOf) {
        setDuplicate({ materialId: payload.data.duplicateOf, contentHash: payload.data.contentHash });
        return;
      }
      goProcessing(payload.data.materialId);
    } catch {
      setSubmitError('网络异常，导入未完成；请重试（文件不会上传两次）');
    } finally {
      setBusy(false);
    }
  };

  const goProcessing = (materialId: string): void => {
    router.push(`/materials/${materialId}/processing`);
    router.refresh();
  };

  const keepCopy = async (): Promise<void> => {
    if (!duplicate) return;
    setBusy(true);
    try {
      const result = await confirmDuplicateChoiceAction({
        materialId: duplicate.materialId,
        choice: 'keep_copy',
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      goProcessing(result.data.materialId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">导入材料</h1>
          <p className="text-xs text-inkMuted">
            第 {step + 1} / {STEP_TITLES.length} 步：{STEP_TITLES[step]}
            {context.existingMaterialCount > 0 ? ` · 已有 ${context.existingMaterialCount} 份材料` : ''}
          </p>
        </div>
        <ol className="flex items-center gap-1">
          {STEP_TITLES.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? 'step' : undefined}
              className={[
                'rounded border px-1.5 py-0.5 text-[10px]',
                index === step
                  ? 'border-brand bg-brand/10 text-brand'
                  : index < step
                    ? 'border-egGreen/40 bg-egGreen/10 text-egGreen'
                    : 'border-line bg-surfaceAlt text-inkMuted',
              ].join(' ')}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-lg border border-line bg-surface p-3">
        {step === 0 && (
          <ImportStepFile
            draft={draft}
            context={context}
            errors={errors}
            onMode={setMode}
            onFile={setFile}
            onPastedText={setPastedText}
            onTitle={setTitle}
          />
        )}
        {step === 1 && (
          <ImportStepSource
            value={source}
            context={context}
            errors={errors}
            onChange={(patch) => setSource((current) => ({ ...current, ...patch }))}
          />
        )}
        {step === 2 && (
          <ImportStepNotice
            context={context}
            rightsConfirmed={source.rightsConfirmed}
            restricted={restricted}
            error={errors.rightsConfirmed}
            onRightsChange={(checked) => setSource((current) => ({ ...current, rightsConfirmed: checked }))}
          />
        )}
        {step === 3 && (
          <ImportStepSubmit
            draft={draft}
            context={context}
            error={submitError}
            busy={busy}
            duplicate={duplicate}
            onSubmit={submit}
            onOpenExisting={() => duplicate && goProcessing(duplicate.materialId)}
            onKeepCopy={keepCopy}
            onBack={() => {
              setDuplicate(null);
              setStep(2);
            }}
          />
        )}
      </div>

      {step < 3 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {step > 0 && (
            <Button variant="ghost" size="sm" onClick={goBack}>
              上一步
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={goNext}>
            <Icon name="down" size={13} />
            下一步
          </Button>
          <span className="text-[11px] text-inkMuted">
            所有字段都会在服务端再校验一次；这一步的填写不会被信任。
          </span>
        </div>
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
