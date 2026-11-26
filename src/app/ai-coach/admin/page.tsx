/**
 * `/ai-coach/admin` AI 管理与治理。
 */

import { AiAdminBody } from '@/components/ai-coach/AiAdminBody';
import { getAiAdminData } from '@/lib/queries/tutor';

export const dynamic = 'force-dynamic';

export default async function AiAdminPage() {
  const data = await getAiAdminData();
  return (
    <AiAdminBody
      engine={data.engine}
      setting={{
        externalAiEnabled: data.setting.externalAiEnabled,
        dailyBudgetUsd: data.setting.dailyBudgetUsd,
        monthlyBudgetUsd: data.setting.monthlyBudgetUsd,
        warnPercent: data.setting.warnPercent,
        directTeachingDefault: data.setting.directTeachingDefault,
        explainLanguage: data.setting.explainLanguage,
        updatedAt: data.setting.updatedAt,
      }}
      externalAiConsent={data.externalAiConsent}
      models={data.models.map((model) => ({
        id: model.id,
        provider: model.provider,
        model: model.model,
        label: model.label,
        active: model.active,
        isDefault: model.isDefault,
        inputPricePerMtok: model.inputPricePerMtok,
        outputPricePerMtok: model.outputPricePerMtok,
      }))}
      templates={data.templates.map((template) => ({
        id: template.id,
        promptKey: template.promptKey,
        purpose: template.purpose,
        mode: template.mode,
        versions: template.versions.map((version) => ({
          id: version.id,
          version: version.version,
          status: version.status,
          checksum: version.checksum,
          publishedAt: version.publishedAt,
        })),
      }))}
      promptVersionCount={data.promptVersionCount}
      credential={data.credential}
    />
  );
}