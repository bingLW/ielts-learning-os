/**
 * `/profile` 分项能力画像。
 */

import { SkillProfilePageBody } from '@/components/profile/SkillProfilePageBody';
import { listSkillProfileRows } from '@/lib/queries/skillProfile';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const rows = await listSkillProfileRows();
  return <SkillProfilePageBody rows={rows} />;
}
