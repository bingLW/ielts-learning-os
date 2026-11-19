import { CyclePageBody } from '@/components/cycle/CyclePageBody';
import { today } from '@/lib/date';
import { getCycleBoard } from '@/lib/queries/cycle';

export const dynamic = 'force-dynamic';

/** `/cycle` 90 天周期与每周复盘。日期口径固定按 Asia/Singapore 业务日现算。 */
export default async function CyclePage() {
  const todayStr = today();
  const board = await getCycleBoard(todayStr);
  return <CyclePageBody board={board} todayStr={todayStr} />;
}
