/**
 * 重排原因输入。原因会写进 `PlanVersion.reason`，是「为什么改」的唯一人工线索。
 */

export function ReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="text-inkMuted">重排原因（可选，最多 500 字）</span>
      <textarea
        value={value}
        maxLength={500}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：今天临时只剩 40 分钟，把精读顺延到明天"
        className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
      />
    </label>
  );
}