import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // `tsconfig.json` 用 `jsx: preserve`（Next 负责编译），但 Vitest 走 esbuild：
  // 不加这一行，`.tsx` 测试会报 "React is not defined"。
  esbuild: { jsx: 'automatic' },
});