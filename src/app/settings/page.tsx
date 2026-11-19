/**
 * `/settings` 系统设置。
 */

import { getProfile } from '@/lib/queries/profile';
import { SettingsBody } from '@/components/settings/SettingsBody';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const profile = await getProfile();

  return (
    <SettingsBody
      profile={{
        targetBandOverall: profile.targetBandOverall,
        targetBandListen: profile.targetBandListen,
        targetBandRead: profile.targetBandRead,
        targetBandWrite: profile.targetBandWrite,
        targetBandSpeak: profile.targetBandSpeak,
        dailyMinutes: profile.dailyMinutes,
        weeklyReviewDow: profile.weeklyReviewDow,
        examDate: profile.examDate,
        aiEnabled: profile.aiEnabled,
        lastExportedAt: profile.lastExportedAt ? profile.lastExportedAt.toISOString() : null,
      }}
    />
  );
}
