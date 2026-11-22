'use client';

/**
 * 来源详情（T13 §5，`/materials/[id]/source`）。
 *
 * 这一页回答的是"这份材料**能不能用**"：
 * - 来源可编辑（改完立刻重算是否受限）；
 * - 受限时顶部红黄警示 + 导出按钮禁用 + **点击禁用按钮也留痕**（R2）；
 * - 下面列出权限留痕（只读）。
 *
 * 「禁用按钮仍可点」是刻意的：真正的导出能力本批不存在，按钮存在的意义是
 * **让用户点一下就知道为什么不行**，并留下一条可审计的记录。所以它视觉上是禁用态
 * （灰、不吸睛），但可交互 —— 点下去写 `MaterialPermissionRecord` 再给提示。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';
import { recordExportBlockedAction } from '@/lib/actions/materialPack';
import { updateMaterialSourceAction } from '@/lib/actions/materials';
import {
  MATERIAL_SOURCE_TYPES,
  MATERIAL_SOURCE_TYPE_LABELS_ZH,
  type MaterialSourceType,
} from '@/lib/constants';
import type {
  MaterialPermissionRecordDto,
  MaterialSourceDto,
} from '@/lib/queries/materials';
import { RightsWarningBanner, isRestrictedSource } from './RightsWarningBanner';

const BTN =
  'inline-flex items-center gap-1 rounded-md border text-xs px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-55';
const BTN_PRIMARY = `${BTN} border-brand bg-brand text-white hover:bg-blue-700`;
const BTN_SECONDARY = `${BTN} border-line bg-surface text-ink hover:bg-surfaceAlt`;
const BTN_BLOCKED = `${BTN} cursor-not-allowed border-line bg-surfaceAlt text-inkMuted`;

const FIELD =
  'w-full rounded border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-brand';
const LABEL = 'text-[10px] text-inkMuted';

/** 留痕动作的中文说明（未知动作原样显示，不吞信息）。 */
const ACTION_LABELS: Record<string, string> = {
  EXPORT_BLOCKED: '导出被拦',
  SHARE_BLOCKED: '分享被拦',
  FETCH_BLOCKED: '抓取被拦',
  DELETE_WARNED: '删除警示',
  RIGHTS_CONFIRMED: '权属确认',
  LICENSE_REQUIRED: '需要许可证',
};

export interface SourceDetailsBodyProps {
  materialId: string;
  source: MaterialSourceDto;
  records: MaterialPermissionRecordDto[];
}

export function SourceDetailsBody({ materialId, source, records }: SourceDetailsBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    sourceType: source.sourceType,
    url: source.url ?? '',
    author: source.author ?? '',
    publisher: source.publisher ?? '',
    publishedYear: source.publishedYear === null ? '' : String(source.publishedYear),
    licenseName: source.licenseName ?? '',
    licenseUrl: source.licenseUrl ?? '',
    userNote: source.userNote ?? '',
  });
  /**
   * 权属确认必须由用户**本次亲手勾选**（A-01 禁止预设）。
   *
   * 已经确认过的材料默认勾上（那是既有事实），但第一次确认时是空白的 ——
   * 我们不替用户声明"我有权使用"。
   */
  const [rightsConfirmed, setRightsConfirmed] = useState(source.rightsConfirmed);

  const restricted = isRestrictedSource(source.sourceType, source.rightsConfirmed);

  const patch = (key: keyof typeof form, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await updateMaterialSourceAction({
        materialId,
        source: {
          sourceType: form.sourceType,
          url: form.url.trim() || null,
          author: form.author.trim() || null,
          publisher: form.publisher.trim() || null,
          // 空串要**省略**而不是传 null：schema 是 `.optional()` + coerce，
          // 传 null 会被 coerce 成 0 然后撞 min(1000)
          ...(form.publishedYear.trim() ? { publishedYear: Number(form.publishedYear) } : {}),
          licenseName: form.licenseName.trim() || null,
          licenseUrl: form.licenseUrl.trim() || null,
          userNote: form.userNote.trim() || null,
          rightsConfirmed,
        },
      });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show(
        result.data.restricted
          ? '来源已保存。来源类型为「不确定」，导出仍然被禁止。'
          : '来源已保存',
        'success',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const tryExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await recordExportBlockedAction({ materialId });
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      if (!result.data.blocked) {
        show(result.data.note, 'success');
        return;
      }
      show(result.data.note, 'error');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <RightsWarningBanner
        sourceType={source.sourceType}
        rightsConfirmed={source.rightsConfirmed}
        licenseName={source.licenseName}
      />

      <section className="space-y-2 rounded-md border border-line bg-surface p-3">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-ink">来源信息</h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={restricted ? BTN_BLOCKED : BTN_SECONDARY}
              onClick={() => void tryExport()}
              disabled={busy}
              aria-disabled={restricted}
              title={restricted ? '来源权属未明确，导出被禁止（点击会记录这次请求）' : '导出原文'}
            >
              <Icon name="external" size={12} />
              {restricted ? '导出原文（已禁止）' : '导出原文'}
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => void save()}
              disabled={busy || !rightsConfirmed}
              title={rightsConfirmed ? undefined : '请先勾选「我确认有权使用这份材料」'}
            >
              <Icon name="check" size={12} />
              保存来源
            </button>
          </div>
        </header>

        <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-0.5">
            <span className={LABEL}>来源类型</span>
            <select
              className={FIELD}
              value={form.sourceType}
              onChange={(event) =>
                patch('sourceType', event.target.value as MaterialSourceType)
              }
              disabled={busy}
            >
              {MATERIAL_SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MATERIAL_SOURCE_TYPE_LABELS_ZH[type]}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-0.5">
            <span className={LABEL}>链接</span>
            <input
              className={FIELD}
              value={form.url}
              onChange={(event) => patch('url', event.target.value)}
              placeholder="https://…"
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5">
            <span className={LABEL}>作者</span>
            <input
              className={FIELD}
              value={form.author}
              onChange={(event) => patch('author', event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5">
            <span className={LABEL}>出版方</span>
            <input
              className={FIELD}
              value={form.publisher}
              onChange={(event) => patch('publisher', event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5">
            <span className={LABEL}>年份</span>
            <input
              className={FIELD}
              value={form.publishedYear}
              onChange={(event) => patch('publishedYear', event.target.value)}
              inputMode="numeric"
              placeholder="2024"
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5">
            <span className={LABEL}>许可证名称</span>
            <input
              className={FIELD}
              value={form.licenseName}
              onChange={(event) => patch('licenseName', event.target.value)}
              placeholder="CC BY-NC 4.0 / 订阅访问"
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5 md:col-span-2">
            <span className={LABEL}>许可证链接</span>
            <input
              className={FIELD}
              value={form.licenseUrl}
              onChange={(event) => patch('licenseUrl', event.target.value)}
              placeholder="https://…"
              disabled={busy}
            />
          </label>

          <label className="space-y-0.5 md:col-span-2">
            <span className={LABEL}>备注</span>
            <textarea
              className={`${FIELD} min-h-16`}
              value={form.userNote}
              onChange={(event) => patch('userNote', event.target.value)}
              placeholder="这份材料是从哪来的、为什么认为自己有权使用"
              disabled={busy}
            />
          </label>
        </div>

        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand"
            checked={rightsConfirmed}
            onChange={(event) => setRightsConfirmed(event.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] leading-relaxed text-ink">
            我确认有权使用这份材料（仅供个人学习；保存会写一条 RIGHTS_CONFIRMED 留痕）
          </span>
        </label>

        <p className="text-[10px] leading-relaxed text-inkMuted">
          来源类型为「不确定」或「订阅制」时，系统会自动追加一条导出限制记录；
          权属确认不会自动解除这两类的导出禁令（它们的限制来自来源本身）。
        </p>
      </section>

      <section className="space-y-2 rounded-md border border-line bg-surface p-3">
        <h2 className="text-[13px] font-semibold text-ink">权限留痕</h2>
        {records.length === 0 ? (
          <p className="text-[11px] text-inkMuted">还没有任何权限相关记录。</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {records.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <span className="rounded border border-line bg-surfaceAlt px-1.5 py-0.5 text-[10px] text-ink">
                  {ACTION_LABELS[record.action] ?? record.action}
                </span>
                <code className="text-[10px] text-inkMuted">{record.rule}</code>
                {record.note && (
                  <span className="min-w-0 flex-1 truncate text-[10px] text-inkMuted">
                    {record.note}
                  </span>
                )}
                <span className="ml-auto text-[10px] tabular-nums text-inkMuted">
                  {record.createdAt.slice(0, 19).replace('T', ' ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
