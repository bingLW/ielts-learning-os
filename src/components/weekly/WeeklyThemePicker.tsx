/**
 * 下周 1 个主要突破目标（PRD §4.8④）。
 *
 * 单选。AI 可给出 3 选 1 建议；AI 未参与时明确写「AI 未参与，本周主题请自选」，
 * 仍允许手写 —— 不因为没有 AI 就把这个区块藏起来。
 *
 * 持久化走既有周复盘备注：选定后由父组件填入备注，随「保存周复盘」一起落库，
 * 不另开一张「周主题」表（v2.7 不新增表）。
 */

import { Card } from '@/components/ui/Card';

export function WeeklyThemePicker({
  suggestions,
  value,
  onChange,
  onFillNote,
  aiNote,
}: {
  suggestions: string[];
  value: string;
  onChange: (value: string) => void;
  onFillNote: () => void;
  aiNote: string;
}) {
  return (
    <Card
      title="下周 1 个主要突破目标"
      description="只选一个；选定后可填入本周备注，随周复盘一起保存"
    >
      {suggestions.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-inkMuted">AI 建议（3 选 1，可改）：{aiNote}</p>
          {suggestions.slice(0, 3).map((option) => (
            <label key={option} className="flex items-start gap-1.5 text-[11px] text-ink">
              <input
                type="radio"
                name="weekly-theme"
                checked={value === option}
                onChange={() => onChange(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-inkMuted">AI 未参与，本周主题请自选（不会自动生成）。</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          aria-label="下周主要突破目标"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={suggestions.length > 0 ? '或手写一个目标' : '例如：口语 Part 2 连续说满 90 秒'}
          className="w-full max-w-md rounded border border-line bg-white px-2 py-1 text-[11px] text-ink"
        />
        <button
          type="button"
          onClick={onFillNote}
          disabled={value.trim().length === 0}
          className="rounded border border-line px-2 py-1 text-[11px] text-ink hover:bg-surfaceAlt disabled:opacity-50"
        >
          填入本周备注
        </button>
      </div>
    </Card>
  );
}