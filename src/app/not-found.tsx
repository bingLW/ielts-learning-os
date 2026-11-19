/**
 * 404。
 */

import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-6 text-center">
      <p className="text-2xl font-semibold text-ink">404</p>
      <p className="mt-1 text-sm text-inkMuted">这个地址不存在，或者对应的数据已被归档。</p>
      <div className="mt-4 flex justify-center gap-2">
        <Link href="/" className={buttonClass('primary', 'md')}>
          回到总览
        </Link>
        <Link href="/plan" className={buttonClass('secondary', 'md')}>
          今日计划
        </Link>
      </div>
    </div>
  );
}
