import type { Config } from 'tailwindcss';

/**
 * Tailwind v3 配置。
 *
 * 三色（GREEN / YELLOW / RED）取自 CSS 变量，保证「同一语义只有一个色值来源」，
 * 同时让 globals.css 里的打印样式与主题色可以统一覆盖。
 *
 * 颜色统一用 `rgb(var(--color-xxx-rgb) / <alpha-value>)` 形式：
 * - 纯色类（如 bg-ink）→ rgb(15 23 42 / 1)，显示与旧的 var(--color-ink) 完全一致；
 * - 透明度类（如 bg-ink/5）→ rgb(15 23 42 / 0.05)，Tailwind 能生成 CSS。
 * 若写成裸 `var(--color-ink)`，Tailwind v3 无法注入 alpha，所有 /N 类都不会生成。
 * globals.css 中两套变量（hex 与 -rgb 通道）必须保持同一色值。
 */
const alpha = (name: string) => `rgb(var(--color-${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        egGreen: alpha('green'),
        egYellow: alpha('yellow'),
        egRed: alpha('red'),
        egPending: alpha('pending'),
        ink: alpha('ink'),
        inkMuted: alpha('ink-muted'),
        surface: alpha('surface'),
        surfaceAlt: alpha('surface-alt'),
        line: alpha('line'),
        brand: alpha('brand'),
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
      },
      screens: {
        /** 窄屏手机（表格 → 卡片切换点在 768px，见 `md`）。 */
        mobile: '600px',
        /** 与 Tailwind 默认一致：<768px 用卡片列表，≥768px 用表格。 */
        md: '768px',
        /** 桌面：固定侧栏。 */
        tablet: '1024px',
      },
    },
  },
  plugins: [],
};

export default config;
