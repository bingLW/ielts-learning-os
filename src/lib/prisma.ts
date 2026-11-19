/**
 * Prisma 客户端单例。
 *
 * Next.js 开发模式会 hot reload 模块，每次都 `new PrismaClient()` 会持续放大
 * 数据库连接数并最终耗尽；因此挂到 `globalThis` 上复用。
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
