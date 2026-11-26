/**
 * 集成测试的建库助手：**强制调用方声明"我读了哪些表"**。
 *
 * 为什么需要它（`41 §10.1`）：此前 15 个集成测试都是各自
 * 「`copyFileSync(dev.db → tmp)` + `deleteMany` 几张表」，而每个文件只清它**想起来**
 * 要清的表。于是任何「读了但没清」的表，值都来自本机 `dev.db` —— 那个库会被应用写入。
 * 结果是套件的绿里混着"我这台机器上恰好是这样"，换台机器可能红、也可能以另一种方式绿。
 *
 * 三条规则：
 *
 * 1. **`delegates` 不许为空**：空的调用等于"我什么都没读"，而集成测试不可能什么都不读。
 *    抛错是为了让作者被迫写下读集，而不是复制一行 `createTestDb([])` 蒙过去。
 * 2. **列的是 Prisma delegate 名（camelCase）**，不是表名（`reviewTask` 而非 `ReviewTask`）。
 *    写错会立刻抛错并指出名字 —— 静默跳过一张表比报错危险得多。
 * 3. **顺序由调用方负责**：有外键的表要**先删子后删父**（例如
 *    `diagnosticAttempt` → `diagnosticItem`）。助手的职责是建库与清表，
 *    不是猜表之间的依赖。
 *
 * 本机 `dev.db` 里**有种子数据**的表（`prisma/seed.ts` 实测）：
 * `learningGoal` / `goalMilestone` / `stage` / `stageAcceptanceItem` / `resource` /
 * `skillAllocationProfile` / `userProfile` / `vocabularySource`。
 * 测试若依赖其中任何一张的**具体行**，必须自己 `deleteMany` + 显式建 fixture。
 *
 * **绝不自动补全成「清空所有表」**：有些测试合法依赖种子数据；若默认清全库，
 * 这些测试会红，然后有人加个逃逸口 —— 又退化成「可以不用的约定」。
 *
 * 迁移口径：存量 15 个集成测试仍是「各自 copyFileSync」，未逐个审计，初始状态
 * 取决于本机 `dev.db`。自检命令（数字应随迁移递减，不降说明有人绕过了本助手）：
 *
 * ```bash
 * grep -rln copyFileSync src/lib --include=*.test.ts | wc -l
 * ```
 *
 * 一个测试文件只建一次库（`DATABASE_URL` 变了但 Prisma 客户端是模块单例，
 * 第二次调用不会换连接）。vitest 按文件隔离 worker，因此这条足够。
 */

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** 一份临时库 + 已清空的声明表。 */
export interface TestDb {
  /** 与全仓共享的同一个客户端实例（模块缓存），直接用即可。 */
  prisma: PrismaClient;
  /** 临时库文件路径（排查时可直接 `sqlite3` 打开）。 */
  path: string;
  /** 删除临时库文件（测试结束调用；重复调用安全）。 */
  cleanup: () => void;
}

const copiedPaths = new Set<string>();

/**
 * 复制 `prisma/dev.db` 到一个临时文件，切 `DATABASE_URL` 过去，然后清空 `delegates`。
 *
 * **必须在任何 `@/lib/prisma` 的静态 import 之前调用**（通常是文件顶部
 * `const { prisma } = await createTestDb([...])`）。否则客户端已经用旧的
 * `DATABASE_URL` 建好了连接池，清的是开发库。
 *
 * @param delegates 要清空的 Prisma delegate 名（camelCase），**不可为空**
 */
export async function createTestDb(delegates: readonly string[]): Promise<TestDb> {
  if (delegates.length === 0) {
    throw new Error('createTestDb: delegates 不能为空 —— 请显式声明这个测试读了哪些表');
  }
  const source = join(process.cwd(), 'prisma', 'dev.db');
  if (!existsSync(source)) throw new Error(`createTestDb: 找不到源库 ${source}`);

  const work = join(
    tmpdir(),
    `ielts-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  copyFileSync(source, work);
  copiedPaths.add(work);
  process.env.DATABASE_URL = `file:${work}?connection_limit=1`;

  const { prisma } = await import('@/lib/prisma');
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');

  for (const name of delegates) {
    const delegate = (prisma as unknown as Record<string, { deleteMany?: unknown }>)[name];
    if (!delegate || typeof delegate.deleteMany !== 'function') {
      throw new Error(`createTestDb: prisma.${name}.deleteMany 不存在（delegate 名写错？表名是 PascalCase，这里要 camelCase）`);
    }
    try {
      await (delegate.deleteMany as (args: Record<string, never>) => Promise<unknown>)({});
    } catch (error) {
      // SQLite 的外键报错不带表名（只给 "FOREIGN KEY constraint failed"），
      // 这里把「哪张表挡住了」补进消息，否则调用方只能猜。
      throw new Error(
        `createTestDb: 清空 ${name} 失败（可能有子表未声明）：${(error as Error).message}`,
      );
    }
  }
  return {
    prisma,
    path: work,
    cleanup: () => {
      copiedPaths.delete(work);
      if (existsSync(work)) rmSync(work, { force: true });
    },
  };
}
