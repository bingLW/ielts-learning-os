/**
 * Prompt Registry：模板 + 追加式版本管理。
 *
 * 规则：已发布版本不可覆盖；内容变化时追加新版本并发布，
 * 旧版本保留供历史会话追溯。checksum 用于判断内容是否真的变了。
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { PROMPT_DEFINITIONS } from './prompts';
import { AI_PROMPT_KEY_BY_KIND, AI_PROMPT_KINDS } from './types';
import type { AiPromptKind } from './types';

export interface PromptVersionRef {
  promptKey: string;
  templateId: string;
  versionId: string;
  version: number;
  checksum: string;
}

export function promptChecksum(kind: AiPromptKind): string {
  const def = PROMPT_DEFINITIONS[kind];
  const source = [
    def.promptKey,
    def.systemTemplate,
    def.userTemplate,
    def.inputSchemaJson,
    def.outputSchemaJson,
  ].join('\n---\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * 确保每个提示词都有已发布版本；内容变化时追加版本。
 * 幂等：重复调用不会产生重复版本。
 */
export async function ensurePromptRegistry(
  prisma: PrismaClient,
  kinds: readonly AiPromptKind[] = AI_PROMPT_KINDS,
): Promise<Record<AiPromptKind, PromptVersionRef>> {
  const result = {} as Record<AiPromptKind, PromptVersionRef>;

  for (const kind of kinds) {
    const def = PROMPT_DEFINITIONS[kind];
    const checksum = promptChecksum(kind);

    const template = await prisma.promptTemplate.upsert({
      where: { promptKey: def.promptKey },
      create: { promptKey: def.promptKey, purpose: def.purpose, mode: def.mode },
      update: { purpose: def.purpose, mode: def.mode },
    });

    const latest = await prisma.promptVersion.findFirst({
      where: { templateId: template.id },
      orderBy: { version: 'desc' },
    });

    if (latest && latest.checksum === checksum) {
      if (latest.status !== 'PUBLISHED') {
        await prisma.promptVersion.update({
          where: { id: latest.id },
          data: { status: 'PUBLISHED', publishedAt: latest.publishedAt ?? new Date() },
        });
      }
      result[kind] = {
        promptKey: def.promptKey,
        templateId: template.id,
        versionId: latest.id,
        version: latest.version,
        checksum,
      };
      continue;
    }

    const created = await prisma.promptVersion.create({
      data: {
        templateId: template.id,
        version: (latest?.version ?? 0) + 1,
        systemTemplate: def.systemTemplate,
        userTemplate: def.userTemplate,
        inputSchemaJson: def.inputSchemaJson,
        outputSchemaJson: def.outputSchemaJson,
        testSamplesJson: def.testSamplesJson,
        checksum,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: 'system',
      },
    });
    result[kind] = {
      promptKey: def.promptKey,
      templateId: template.id,
      versionId: created.id,
      version: created.version,
      checksum,
    };
  }

  return result;
}

/** 读取当前已发布版本；没有则返回 null（调用方应提示先初始化）。 */
export async function getPublishedPromptVersion(
  prisma: PrismaClient,
  kind: AiPromptKind,
): Promise<PromptVersionRef | null> {
  const promptKey = AI_PROMPT_KEY_BY_KIND[kind];
  const template = await prisma.promptTemplate.findUnique({ where: { promptKey } });
  if (!template) return null;
  const version = await prisma.promptVersion.findFirst({
    where: { templateId: template.id, status: 'PUBLISHED' },
    orderBy: { version: 'desc' },
  });
  if (!version) return null;
  return {
    promptKey,
    templateId: template.id,
    versionId: version.id,
    version: version.version,
    checksum: version.checksum,
  };
}