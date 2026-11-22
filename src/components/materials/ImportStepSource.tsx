'use client';

/**
 * 导入向导第 2 步：来源与权限登记（PRD §3.1 七类来源）。
 *
 * 三个「必须」在这里就提示（真正的拦截在 zod 层，前后端同一份 schema）：
 * - `open_license` 必须填许可名称；
 * - `user_provided_url` 必须填链接；
 * - 来源不确定 / 付费订阅会被标记为受限（禁止导出与原文下载，A-05）。
 */

import { FormField, inputClass, selectClass } from '@/components/ui/FormField';
import type { ImportContextDto } from '@/lib/queries/materials';
import type { SourceDraft } from './importTypes';

export function ImportStepSource({
  value,
  context,
  errors,
  onChange,
}: {
  value: SourceDraft;
  context: ImportContextDto;
  errors: Record<string, string>;
  onChange: (patch: Partial<SourceDraft>) => void;
}) {
  const selected = context.sourceTypes.find((item) => item.value === value.sourceType);

  return (
    <div className="space-y-3">
      <FormField
        label="这份材料是哪种来源"
        required
        error={errors.sourceType ?? errors['source.sourceType']}
        hint={selected?.restricted ? '该来源属于受限来源：禁止导出与原文下载' : '来源信息会写入权限留痕，便于日后追溯'}
      >
        <select
          className={selectClass}
          value={value.sourceType}
          onChange={(event) => onChange({ sourceType: event.target.value as SourceDraft['sourceType'] })}
        >
          {context.sourceTypes.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
              {item.restricted ? '（受限）' : ''}
            </option>
          ))}
        </select>
      </FormField>

      {selected?.requiresUrl && (
        <FormField
          label="材料链接"
          required
          error={errors.url ?? errors['source.url']}
          hint="以 http(s):// 开头；本期只保存链接，不抓取网页正文"
        >
          <input
            className={inputClass}
            value={value.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder="https://example.com/article"
          />
        </FormField>
      )}

      {selected?.requiresLicenseName && (
        <>
          <FormField
            label="许可名称"
            required
            error={errors.licenseName ?? errors['source.licenseName']}
            hint="例如 CC BY 4.0 / CC BY-NC-SA 3.0 / Public Domain Mark"
          >
            <input
              className={inputClass}
              value={value.licenseName}
              onChange={(event) => onChange({ licenseName: event.target.value })}
              placeholder="CC BY 4.0"
            />
          </FormField>
          <FormField
            label="许可链接"
            error={errors.licenseUrl ?? errors['source.licenseUrl']}
            hint="以 http(s):// 开头（可选）"
          >
            <input
              className={inputClass}
              value={value.licenseUrl}
              onChange={(event) => onChange({ licenseUrl: event.target.value })}
              placeholder="https://creativecommons.org/licenses/by/4.0/"
            />
          </FormField>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="作者" error={errors.author ?? errors['source.author']}>
          <input
            className={inputClass}
            value={value.author}
            onChange={(event) => onChange({ author: event.target.value })}
            maxLength={200}
          />
        </FormField>
        <FormField label="出版方" error={errors.publisher ?? errors['source.publisher']}>
          <input
            className={inputClass}
            value={value.publisher}
            onChange={(event) => onChange({ publisher: event.target.value })}
            maxLength={200}
          />
        </FormField>
        <FormField label="出版年份" error={errors.publishedYear ?? errors['source.publishedYear']}>
          <input
            className={inputClass}
            value={value.publishedYear}
            onChange={(event) => onChange({ publishedYear: event.target.value.replace(/[^0-9]/g, '') })}
            inputMode="numeric"
            placeholder="2024"
            maxLength={4}
          />
        </FormField>
      </div>

      <FormField label="备注" hint="例如「老师发的讲义」「朋友推荐的播客文字稿」">
        <input
          className={inputClass}
          value={value.userNote}
          onChange={(event) => onChange({ userNote: event.target.value })}
          maxLength={1000}
        />
      </FormField>
    </div>
  );
}
