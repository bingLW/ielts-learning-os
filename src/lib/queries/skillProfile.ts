/**
 * 分项画像只读查询。
 *
 * 四项技能固定返回（即使没有任何证据），让空状态本身也是信息：
 * 「尚未评估」和「评估为低置信度」是两件事。
 */

import { PROFILE_SKILLS } from '@/lib/constants';
import { previewOutput } from '@/lib/domain/evidence';
import { suggestProfileConfidence } from '@/lib/domain/profile';
import { parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import type {
  AssistanceLevel,
  EvidenceConfidence,
  LearningEvidenceType,
  ProfileEvidenceOptionDto,
  SkillDirection,
  SkillProfileRowDto,
} from '@/lib/types';

export type ProfileSkill = (typeof PROFILE_SKILLS)[number];

export async function listSkillProfileRows(): Promise<SkillProfileRowDto[]> {
  const [profiles, evidence] = await Promise.all([
    prisma.skillProfile.findMany(),
    prisma.evidenceRecord.findMany({
      where: { archivedAt: null, skill: { in: PROFILE_SKILLS } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        skill: true,
        evidenceType: true,
        assistanceLevel: true,
        outputText: true,
        createdAt: true,
      },
    }),
  ]);

  const bySkill = new Map<string, typeof evidence>();
  for (const record of evidence) {
    const list = bySkill.get(record.skill) ?? [];
    list.push(record);
    bySkill.set(record.skill, list);
  }

  return PROFILE_SKILLS.map((skill) => {
    const profile = profiles.find((row) => row.skill === skill) ?? null;
    const records = bySkill.get(skill) ?? [];
    const suggestion = suggestProfileConfidence(
      records.map((record) => ({
        evidenceType: record.evidenceType as LearningEvidenceType,
        assistanceLevel: record.assistanceLevel as AssistanceLevel,
      })),
    );
    const options: ProfileEvidenceOptionDto[] = records.slice(0, 40).map((record) => ({
      id: record.id,
      evidenceType: record.evidenceType as LearningEvidenceType,
      assistanceLevel: record.assistanceLevel as AssistanceLevel,
      independent: record.assistanceLevel === 'A0',
      preview: previewOutput(record.outputText, 80),
      createdAt: record.createdAt.toISOString(),
    }));

    return {
      skill,
      direction: (profile?.direction as SkillDirection | null) ?? null,
      confidence: (profile?.confidence as EvidenceConfidence) ?? 'LOW',
      evidenceBasis: parseStringArray(profile?.evidenceBasis),
      lastAssessedAt: profile?.lastAssessedAt ?? null,
      reviewDueAt: profile?.reviewDueAt ?? null,
      doNotInfer: profile?.doNotInfer ?? null,
      note: profile?.note ?? null,
      evidenceCount: records.length,
      independentCount: records.filter((record) => record.assistanceLevel === 'A0').length,
      suggestion: suggestion.confidence,
      suggestionReasons: suggestion.reasons,
      gaps: suggestion.gaps,
      options,
    };
  });
}

export function isProfileSkill(value: string): value is ProfileSkill {
  return (PROFILE_SKILLS as string[]).includes(value);
}
