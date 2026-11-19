'use client';

/**
 * 全局错误态：显示可读原因 + 重试按钮，绝不吞掉错误。
 *
 * 注意：Server Action 的失败不走这里（它们返回 `ActionResult`），
 * 这里只接住渲染期异常（例如数据库未初始化）。
 */

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 保留控制台堆栈，便于定位；UI 上只给可读摘要
    console.error('[page-error]', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl rounded-lg border border-red-200 bg-red-50 p-5">
      <h1 className="text-sm font-semibold text-red-800">这个页面出错了</h1>
      <p className="mt-1 text-xs text-red-700">
        数据没有被写入，也不会被静默忽略。你可以重试，或先检查数据库是否已初始化
        （`npm run db:push && npm run db:seed`）。
      </p>
      <pre className="mt-2 max-h-40 overflow-auto rounded border border-red-200 bg-white p-2 text-[11px] text-red-800">
        {error.message}
        {error.digest ? `\n(digest: ${error.digest})` : ''}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
      >
        重试
      </button>
    </div>
  );
}
