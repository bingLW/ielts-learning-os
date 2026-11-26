/**
 * G-11 预算唯一入口（T10）。
 *
 * 预算解析只允许走 `getEffectiveBudget` / `getBudgetRange`（`domain/budget.ts`
 * 一套优先级：DailyBudget → 星期模板 → 默认建议值）。服务层/动作层自己拼
 * 「dailyBudget + weeklyTarget」时会漏掉优先级回落，于是计划页显示 90、
 * 周报显示 240 —— 两个数字都叫「预算」，用户无法判断哪个算数。
 *
 * 唯一合法同时碰这两张表的地方是预算的**写入口**（`actions/budget.ts`）：
 * 它 upsert 当日预算与周目标，本来就要同时操作两张表，且不解析「有效预算」。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full);
      } else if (entry.endsWith('.ts')) {
        out.push(relative(ROOT, full).split('\\').join('/'));
      }
    }
  };
  for (const dirName of [dir]) {
    try {
      const full = join(ROOT, dirName);
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // 目录不存在时跳过
    }
  }
  return out;
}

function combinesBudgetTables(source: string): boolean {
  return /\.dailyBudget\b/.test(source) && /\.weeklyTarget\b/.test(source);
}

/** 预算的唯一合法写入口（upsert 两张表，不解析有效预算）。 */
const ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: 'src/lib/actions/budget.ts',
    reason: '预算/周目标的唯一写入口；它写表，不解析「有效预算」',
  },
];

describe('G-11 预算解析只有一个入口', () => {
  it('services/** 与 actions/** 不出现「dailyBudget + weeklyTarget」自拼组合', () => {
    const files = [...listTsFiles('src/lib/services'), ...listTsFiles('src/lib/actions')];
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));
    const violations = files.filter(
      (file) => !allowed.has(file) && combinesBudgetTables(readFileSync(join(ROOT, file), 'utf8')),
    );

    expect(violations, '预算解析必须走 getEffectiveBudget / getBudgetRange').toEqual([]);
  });

  it('白名单无僵尸条目', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(6);
      expect(
        combinesBudgetTables(readFileSync(join(ROOT, entry.file), 'utf8')),
        `白名单僵尸：${entry.file} 已不再同时操作两张预算表`,
      ).toBe(true);
    }
  });
});