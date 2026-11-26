/**
 * `/speaking` 口语实验室（v2.5 Speaking Lab）。
 */

import { listSpeakingPrompts, listSpeakingSessions, listUnassignedRecordings } from '@/lib/queries/listening';
import { SpeakingPageBody } from '@/components/speaking/SpeakingPageBody';

export const dynamic = 'force-dynamic';

export default async function SpeakingPage() {
  const [prompts, sessions, unassignedRecordings] = await Promise.all([
    listSpeakingPrompts(),
    listSpeakingSessions(),
    listUnassignedRecordings(),
  ]);

  return <SpeakingPageBody prompts={prompts} sessions={sessions} unassignedRecordings={unassignedRecordings} />;
}
