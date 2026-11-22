/**
 * 文件名的展示层净化（架构 §6.6「显示文件名」）。
 *
 * 只在**渲染前**使用：数据库里保留 `originFileName` 原值（审计需要），
 * 但任何进入 DOM / 导出 / 日志的场合都必须先过这里，避免
 * 控制字符、路径分隔符、超长名把界面或日志搞坏。
 */

import { MATERIAL_LIMITS } from '@/lib/constants';

const FORBIDDEN = /[/\\:*?"<>|]/g;
/** C0 控制符与 DEL、以及零宽字符（`\u200B-\u200D`、`\uFEFF`）。 */
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g;

/**
 * 净化用于展示的文件名。
 *
 * @param name 原始文件名（可含路径分隔符，来自浏览器）
 * @param maxLength 最大长度，默认 `MATERIAL_LIMITS.maxDisplayFileNameChars`
 */
export function sanitizeDisplayFileName(
  name: string,
  maxLength: number = MATERIAL_LIMITS.maxDisplayFileNameChars,
): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(CONTROL, '').replace(FORBIDDEN, '').trim();
  if (cleaned.length === 0) return '未命名文件';
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** 去扩展名的展示标题（用于材料默认标题）。 */
export function fileNameToTitle(name: string): string {
  const safe = sanitizeDisplayFileName(name);
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  return stem.trim() || safe;
}

/** 词数统计（拉丁词 + CJK 字各自计数，与解析阶段口径一致）。 */
export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;
  return cjk + latin;
}
