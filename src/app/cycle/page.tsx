import { CyclePageBody } from '@/components/cycle/CyclePageBody';
import { businessToday } from '@/lib/businessTime';
import { getCycleBoard } from '@/lib/queries/cycle';

export const dynamic = 'force-dynamic';

/** `/cycle` 90 天周期与每周复盘：日期口径按用户配置的业务时区现算。 */
export default async function CyclePage() {
  const todayStr = await businessToday();
  const board = await getCycleBoard(todayStr);
  return <CyclePageBody board={board} todayStr={todayStr} />;
}
