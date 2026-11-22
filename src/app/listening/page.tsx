/**
 * `/listening` 听力实验室（v2.5 Listening Lab）。
 */

import { listAudioAssets, listListeningExercises, listTranscriptsForAudio } from '@/lib/queries/listening';
import { ListeningPageBody } from '@/components/listening/ListeningPageBody';

export const dynamic = 'force-dynamic';

export default async function ListeningPage() {
  const [assets, exercises] = await Promise.all([
    listAudioAssets(),
    listListeningExercises(),
  ]);

  // 每个音源的转写（按需聚合）。
  const transcripts: Record<string, Awaited<ReturnType<typeof listTranscriptsForAudio>>> = {};
  await Promise.all(
    assets.map(async (asset) => {
      transcripts[asset.id] = await listTranscriptsForAudio(asset.id);
    }),
  );

  return <ListeningPageBody assets={assets} exercises={exercises} transcripts={transcripts} />;
}
