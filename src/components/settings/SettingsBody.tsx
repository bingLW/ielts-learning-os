'use client';

/**
 * 系统设置：学习目标 / 时间与时长 / 导出备份 / AI 预留 / 免责声明。
 *
 * 时区字段**只读**（固定 Asia/Singapore）：这不是「忘了开放」，而是产品硬约束，
 * 因为所有业务日期都按 +08:00 切分，可改时区会让历史数据口径不一致。
 */

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateProfileAction } from '@/lib/actions/settings';
import { shutdownApplicationAction } from '@/lib/actions/listening';
import {
  BUDGET_PRESET_MINUTES,
  DISCLAIMER_BAND,
  DISCLAIMER_CEFR,
  DOMAIN_EXPORT_KINDS,
  SCHEMA_VERSION,
  TZ_NAME,
} from '@/lib/constants';
import { formatBand } from '@/lib/format';
import { EXPORT_TABLES, TABLE_FILE_NAME } from '@/lib/export/mapping';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';
import { Toast, useToastState } from '@/components/ui/Toast';

export interface SettingsProfileDto {
  targetBandOverall: number;
  targetBandListen: number | null;
  targetBandRead: number | null;
  targetBandWrite: number | null;
  targetBandSpeak: number | null;
  dailyMinutes: number;
  weeklyReviewDow: number;
  examDate: string | null;
  aiEnabled: boolean;
  lastExportedAt: string | null;
}

const DOW_OPTIONS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 领域报表类别 → 文案。
 *
 * 刻意不 import `lib/export/domain`（它依赖 prisma，会把服务端代码带进客户端包），
 * 所以这里只保留展示文案。
 */
const DOMAIN_EXPORT_LABEL: Record<(typeof DOMAIN_EXPORT_KINDS)[number], string> = {
  grammar: '语法诊断（EGIU）',
  mistakes: '错题本',
  vocab: '词汇',
  sentences: '句子成分分析',
  reviews: '复习队列',
};

export function SettingsBody({ profile }: { profile: SettingsProfileDto }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [targetBandOverall, setTargetBandOverall] = useState(profile.targetBandOverall);
  const [listen, setListen] = useState(profile.targetBandListen ?? 0);
  const [read, setRead] = useState(profile.targetBandRead ?? 0);
  const [write, setWrite] = useState(profile.targetBandWrite ?? 0);
  const [speak, setSpeak] = useState(profile.targetBandSpeak ?? 0);
  const [dailyMinutes, setDailyMinutes] = useState(profile.dailyMinutes);
  const [weeklyReviewDow, setWeeklyReviewDow] = useState(profile.weeklyReviewDow);
  const [examDate, setExamDate] = useState(profile.examDate ?? '');
  const [aiEnabled, setAiEnabled] = useState(profile.aiEnabled);

  const save = () => {
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateProfileAction({
        targetBandOverall,
        targetBandListen: listen || undefined,
        targetBandRead: read || undefined,
        targetBandWrite: write || undefined,
        targetBandSpeak: speak || undefined,
        dailyMinutes,
        weeklyReviewDow,
        examDate: examDate || undefined,
        aiEnabled,
      });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        show(result.error, 'error');
        return;
      }
      show('设置已保存', 'success');
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-base font-semibold text-ink">系统设置</h1>
        <p className="text-xs text-inkMuted">
          纯本地单用户工作台 · 数据不上传 · 每日备份保留 7 份
        </p>
      </div>

      <Card
        title="学习目标"
        description="Band 分为「个人目标分」，不是官方成绩。"
        actions={
          <button type="button" onClick={save} disabled={pending} className={buttonClass('primary', 'sm')}>
            <Icon name="check" size={12} />
            {pending ? '保存中…' : '保存设置'}
          </button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <FormField
            label="雅思目标总分"
            htmlFor="band-overall"
            required
            error={fieldErrors.targetBandOverall}
            hint="0.5 步进，初始 6.0–6.5"
          >
            <input
              id="band-overall"
              type="number"
              step={0.5}
              min={0}
              max={9}
              value={targetBandOverall}
              onChange={(event) => setTargetBandOverall(Number(event.target.value))}
              className={inputClass}
            />
          </FormField>
          <FormField label="听力单项目标" htmlFor="band-listen" error={fieldErrors.targetBandListen}>
            <input
              id="band-listen"
              type="number"
              step={0.5}
              min={0}
              max={9}
              value={listen}
              onChange={(event) => setListen(Number(event.target.value))}
              className={inputClass}
            />
          </FormField>
          <FormField label="阅读单项目标" htmlFor="band-read" error={fieldErrors.targetBandRead}>
            <input
              id="band-read"
              type="number"
              step={0.5}
              min={0}
              max={9}
              value={read}
              onChange={(event) => setRead(Number(event.target.value))}
              className={inputClass}
            />
          </FormField>
          <FormField label="写作单项目标" htmlFor="band-write" error={fieldErrors.targetBandWrite}>
            <input
              id="band-write"
              type="number"
              step={0.5}
              min={0}
              max={9}
              value={write}
              onChange={(event) => setWrite(Number(event.target.value))}
              className={inputClass}
            />
          </FormField>
          <FormField label="口语单项目标" htmlFor="band-speak" error={fieldErrors.targetBandSpeak}>
            <input
              id="band-speak"
              type="number"
              step={0.5}
              min={0}
              max={9}
              value={speak}
              onChange={(event) => setSpeak(Number(event.target.value))}
              className={inputClass}
            />
          </FormField>
          <FormField label="目标考试日期" htmlFor="exam-date">
            <input
              id="exam-date"
              type="date"
              value={examDate}
              onChange={(event) => setExamDate(event.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>
      </Card>

      <Card title="时间与时长">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <FormField
            label="每日可用分钟（v2.0 旧字段）"
            htmlFor="daily-minutes"
            required
            error={fieldErrors.dailyMinutes}
            hint="v2.1 已改为按日期单独设置；这里保留是为了 v2.0 兼容"
          >
            <select
              id="daily-minutes"
              value={dailyMinutes}
              onChange={(event) => setDailyMinutes(Number(event.target.value))}
              className={selectClass}
            >
              {BUDGET_PRESET_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} 分钟
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="周复盘日" htmlFor="review-dow" error={fieldErrors.weeklyReviewDow}>
            <select
              id="review-dow"
              value={weeklyReviewDow}
              onChange={(event) => setWeeklyReviewDow(Number(event.target.value))}
              className={selectClass}
            >
              {DOW_OPTIONS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="时区（只读）" hint="固定 +08:00，无夏令时；业务日期按此切分">
            <input value={`${TZ_NAME} · UTC+08:00`} readOnly disabled className={inputClass} />
          </FormField>

          <FormField label="专注块 / 休息" hint="默认 45–50 分钟专注 + 5–10 分钟休息，休息不计入净时长">
            <input value="45–50 分钟 / 5–10 分钟" readOnly disabled className={inputClass} />
          </FormField>
        </div>
      </Card>

      <Card title="数据导出与备份" description={`schema_version = ${SCHEMA_VERSION} · 导出文件含导出时间与各表条数`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <a href="/api/export/json" className={buttonClass('primary', 'sm')}>
            <Icon name="external" size={12} />
            下载全量 JSON
          </a>
          <Link href="/resources" className={buttonClass('secondary', 'sm')}>
            <Icon name="folder" size={12} />
            资源库管理
          </Link>
          <span className="text-[11px] text-inkMuted">
            上次导出：{profile.lastExportedAt ? profile.lastExportedAt.slice(0, 10) : '从未导出'}
          </span>
        </div>

        <details className="mt-2 rounded-md border border-line bg-surfaceAlt p-2">
          <summary className="cursor-pointer text-xs font-medium text-ink">
            按表下载 CSV（{EXPORT_TABLES.length} 张）
          </summary>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {EXPORT_TABLES.map((table) => (
              <li key={table}>
                <a
                  href={`/api/export/csv?table=${table}`}
                  className="rounded border border-line bg-white px-1.5 py-0.5 text-[11px] text-inkMuted hover:bg-surface"
                >
                  {TABLE_FILE_NAME[table]}.csv
                </a>
              </li>
            ))}
          </ul>
        </details>

        <details className="mt-2 rounded-md border border-line bg-surfaceAlt p-2">
          <summary className="cursor-pointer text-xs font-medium text-ink">
            下载领域报表（{DOMAIN_EXPORT_KINDS.length} 类可读 CSV）
          </summary>
          <p className="mt-1 text-[11px] text-inkMuted">
            与技术备份的区别：领域报表的列名是中文业务字段，可直接阅读或贴进复盘文档。
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {DOMAIN_EXPORT_KINDS.map((kind) => (
              <li key={kind}>
                <a
                  href={`/api/export/domain/${kind}`}
                  className="rounded border border-line bg-white px-1.5 py-0.5 text-[11px] text-inkMuted hover:bg-surface"
                >
                  {DOMAIN_EXPORT_LABEL[kind]}
                </a>
              </li>
            ))}
          </ul>
        </details>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link href="/weekly?tab=analytics" className="text-[11px] text-brand underline">
            分析看板（十张图）
          </Link>
          <Link href="/review" className="text-[11px] text-brand underline">
            复习中心
          </Link>
          <Link href="/weekly" className="text-[11px] text-brand underline">
            每周复盘
          </Link>
        </div>
      </Card>

      <Card title="AI 建议（本地规则引擎）" description="从真实学习数据生成建议，每条带「依据」；与学习成绩物理分区，仅供参考。">
        <label className="flex items-center gap-1.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(event) => setAiEnabled(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          {aiEnabled ? '已开启（本地规则引擎，不接外部模型）' : '未开启'}
        </label>
      </Card>

      <Card title="关于与免责声明">
        <ul className="list-inside list-disc space-y-1 text-xs text-inkMuted">
          <li>{DISCLAIMER_CEFR}</li>
          <li>{DISCLAIMER_BAND}</li>
          <li>
            本工具不提供打卡、连续天数、排行榜等叙事；「计划完成率」与「净学习时长」必须成对解读，
            任一单项都不能代表英语能力提升。
          </li>
          <li>当前目标分：Band {formatBand(profile.targetBandOverall)}（个人目标，非官方成绩）。</li>
        </ul>
      </Card>

      <Card title="退出系统" description="关闭本机正在运行的应用进程（单用户本机应用）。">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-inkMuted">
            点击「退出系统」将关闭当前程序。请先确认已保存所有学习记录，未完成的计时会被保留在服务端。
          </p>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('确定要退出系统、关闭程序吗？')) {
                void shutdownApplicationAction().then((result) => {
                  if (result.ok) {
                    // 服务端 300ms 后终止进程；前端随后提示，避免页面卡死。
                    window.setTimeout(() => {
                      window.alert('应用已关闭。可以安全关闭此标签页。');
                    }, 600);
                  }
                });
              }
            }}
            className="w-fit rounded-lg bg-egRed px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            退出系统
          </button>
        </div>
      </Card>

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
