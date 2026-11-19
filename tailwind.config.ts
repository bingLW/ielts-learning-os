import type { Config } from 'tailwindcss';

/**
 * Tailwind v3 配置。
 *
 * 三色（GREEN / YELLOW / RED）取自 CSS 变量，保证「同一语义只有一个色值来源」，
 * 同时让 globals.css 里的打印样式与主题色可以统一覆盖。
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        egGreen: 'var(--color-green)',
        egYellow: 'var(--color-yellow)',
        egRed: 'var(--color-red)',
        egPending: 'var(--color-pending)',
        ink: 'var(--color-ink)',
        inkMuted: 'var(--color-ink-muted)',
        surface: 'var(--color-surface)',
        surfaceAlt: 'var(--color-surface-alt)',
        line: 'var(--color-line)',
        brand: 'var(--color-brand)',
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
