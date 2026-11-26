/**
 * `createTestDb` 自己的测试（T10 ⑫b）。
 *
 * 这个助手是「守卫的守卫」：若无测试，它可能悄悄退化成
 * 「也清不干净、但看不出来」。四条断言对应用户能观察到的四件事：
 * 空声明要炸、声明了要真清、两次建库互不污染、cleanup 要真删文件。
 *
 * 本文件**只 import 助手**（不 import `@/lib/prisma`）：助手内部动态 import，
 * 才能在设置 `DATABASE_URL` 之后再建立连接。提前静态 import 会让整个文件
 * 悄悄连到开发库上。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../testDb';

describe('createTestDb 夹具', () => {
  it('① 声明为空 → 直接抛错，且消息说清「必须声明」', async () => {
    await expect(createTestDb([])).rejects.toThrow(/不能为空|必须声明/);
  });

  it('② 声明 LearningGoal → 计数为 0（证明清真的生效）', async () => {
    const db = await createTestDb(['LearningGoal']);
    try {
      expect(await db.prisma.learningGoal.count()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('③ 连续两次建库 → 两个不同的临时路径', async () => {
    const first = await createTestDb(['UserProfile']);
    const second = await createTestDb(['UserProfile']);
    try {
      expect(first.path).not.toBe(second.path);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('④ cleanup 之后临时文件不存在', async () => {
    const db = await createTestDb(['UserProfile']);
    expect(existsSync(db.path)).toBe(true);
    db.cleanup();
    expect(existsSync(db.path)).toBe(false);
  });
});