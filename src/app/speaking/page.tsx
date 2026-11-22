/**
 * `/speaking` 口语实验室（v2.5 Speaking Lab）。
 */

import { listSpeakingPrompts, listSpeakingSessions } from '@/lib/queries/listening';
import { SpeakingPageBody } from '@/components/speaking/SpeakingPageBody';

export const dynamic = 'force-dynamic';

export default async function SpeakingPage() {
  const [prompts, sessions] = await Promise.all([
    listSpeakingPrompts(),
    listSpeakingSessions(),
  ]);

  return <SpeakingPageBody prompts={prompts} sessions={sessions} />;
}
