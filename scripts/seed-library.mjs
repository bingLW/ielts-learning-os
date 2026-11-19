#!/usr/bin/env node
/**
 * 方法论资料库 seed（幂等）。
 *
 * 1. 读取 src/lib/librarySeed.json（唯一数据源，16 条）；
 * 2. 按 url 幂等 upsert 元数据（标题/作者/许可/阶段/摘要）；
 * 3. 绝不改动 ResourceReadingLog —— 重跑不会覆盖用户笔记与阅读状态。
 *
 * 用法：node scripts/seed-library.mjs
 */

import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const EXPECTED = 16;
const seedUrl = new URL('../src/lib/librarySeed.json', import.meta.url);
const items = JSON.parse(await readFile(seedUrl, 'utf8'));

if (!Array.isArray(items) || items.length !== EXPECTED) {
  console.error(`seed 数据必须恰好 ${EXPECTED} 条，实际 ${Array.isArray(items) ? items.length : '非数组'}`);
  process.exit(1);
}

const prisma = new PrismaClient();
let created = 0;
let updated = 0;

try {
  for (const item of items) {
    const data = {
      title: item.title,
      creator: item.creator,
      url: item.url,
      resourceType: item.resourceType,
      priority: item.priority,
      category: item.category,
      stageFit: JSON.stringify(item.stageFit),
      licenseNote: item.licenseNote,
      summary: item.summary,
      sortOrder: item.sortOrder,
      status: 'ACTIVE',
    };
    const existing = await prisma.resourceReference.findUnique({
      where: { url: item.url },
      select: { id: true },
    });
    if (existing) {
      await prisma.resourceReference.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.resourceReference.create({ data });
      created += 1;
    }
  }

  const total = await prisma.resourceReference.count();
  const logs = await prisma.resourceReadingLog.count();
  console.log(`seed 完成：新增 ${created} 条，更新 ${updated} 条，库内共 ${total} 条；阅读日志 ${logs} 条未改动。`);
} finally {
  await prisma.$disconnect();
}
