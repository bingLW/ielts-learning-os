/**
 * 疑似注入提示横幅（ADR-04 L5）。
 *
 * 关键取舍：**只提示，不阻断、不删改原文**。
 * - 原文完整性优先：删掉"可疑段落"会让学生读到一份缺页的材料；
 * - 提示必须存在：用户有权知道这段材料在试图操纵 AI。
 *
 * 因此这个组件只读 `ContentChunk.suspicionFlags`（由 analyzing 阶段写入），
 * 并且在两种阅读模式下都会显示 —— 它不是 AI 分析结果，而是安全提示。
 */

import { Icon } from '@/components/ui/Icon';
import {
  MATERIAL_SUSPICION_FLAG_LABELS_ZH,
  type MaterialSuspicionFlag,
} from '@/lib/constants';

export interface InjectionNoticeProps {
  /** 命中疑似话术的 chunk 数。 */
  affectedChunks: number;
  flags: MaterialSuspicionFlag[];
}

export function InjectionNotice({ affectedChunks, flags }: InjectionNoticeProps) {
  if (affectedChunks <= 0) return null;

  return (
    <div
      role="status"
      className="rounded-md border border-egYellow/50 bg-egYellow/10 p-2.5 text-[11px] leading-relaxed text-ink"
    >
      <p className="flex items-center gap-1 font-semibold">
        <Icon name="alert" size={12} />
        本材料有 {affectedChunks} 个段落疑似包含「针对 AI 的指令性文字」
      </p>
      {flags.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-inkMuted">
          {flags.map((flag) => (
            <li key={flag}>{MATERIAL_SUSPICION_FLAG_LABELS_ZH[flag]}</li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-inkMuted">
        已按「只标记、不执行」处理：正文一字未改，分析结果也照常生成，但请你自己判断这些段落是否可信。
      </p>
    </div>
  );
}
