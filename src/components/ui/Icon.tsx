/**
 * 内联 SVG 图标。
 *
 * 刻意不使用 `lucide-react`：本项目的依赖树里该包版本与上游命名不一致（架构 §8 也标注了
 * 这个风险），内联 SVG 零依赖、不会因为包版本变化而构建失败。
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'calendar'
  | 'list'
  | 'book'
  | 'bookOpen'
  | 'repeat'
  | 'type'
  | 'quote'
  | 'flag'
  | 'chart'
  | 'folder'
  | 'settings'
  | 'menu'
  | 'close'
  | 'play'
  | 'pause'
  | 'check'
  | 'plus'
  | 'trash'
  | 'up'
  | 'down'
  | 'alert'
  | 'clock'
  | 'external'
  | 'circle';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  book: 'M4 4h9a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM16 7h4v13h-4',
  bookOpen: 'M12 6C10 4.5 7.5 4 4 4v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V4c-3.5 0-6 .5-8 2zM12 6v14',
  repeat: 'M4 10V7a3 3 0 0 1 3-3h10l-3-3M20 14v3a3 3 0 0 1-3 3H7l3 3',
  type: 'M4 19 9 5l5 14M6 14h6M16 19l3-8 3 8M17 16h4',
  quote: 'M8 7H5v5h3v5H5M19 7h-3v5h3v5h-3',
  flag: 'M5 21V4M5 4h10l-1 3 1 3H5',
  chart: 'M4 20V10M10 20V5M16 20v-7M22 20H2',
  folder: 'M3 7h6l2 2h10v10H3z',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M8 5l11 7-11 7z',
  pause: 'M9 5v14M15 5v14',
  check: 'M4 12l5 5L20 6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  alert: 'M12 4l9 16H3zM12 10v5M12 18h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  external: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

/** 描边图标（`currentColor`，跟随文字色）。 */
export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
