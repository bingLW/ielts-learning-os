/**
 * 单用户配置读取。固定 1 行（`id = 1`）。
 */

import type { UserProfile } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** 读取配置；库为空时按 schema 默认值建一行（幂等）。 */
export async function getProfile(): Promise<UserProfile> {
  const existing = await prisma.userProfile.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.userProfile.create({ data: { id: 1 } });
}
