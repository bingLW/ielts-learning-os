/**
 * `/ai-coach` AI Learning Coach 首页。
 */

import { AiCoachHomeBody } from '@/components/ai-coach/AiCoachHomeBody';
import { getAiCoachHomeData } from '@/lib/queries/tutor';

export const dynamic = 'force-dynamic';

export default async function AiCoachPage() {
  const data = await getAiCoachHomeData();
  return (
    <AiCoachHomeBody
      engine={data.engine}
      sessions={data.sessions}
      externalAiEnabled={data.externalAiEnabled}
      apiKeyPresent={data.apiKeyPresent}
      explainLanguage={data.explainLanguage}
      directTeachingDefault={data.directTeachingDefault}
    />
  );
}