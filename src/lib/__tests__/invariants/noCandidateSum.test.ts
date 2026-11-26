/**
 * G-2 候选分钟不进统计（T10）。
 *
 * `TaskCandidate.estMinutes` / `TaskProposalItem.suggestedMinutes` 是**预计**，
 * 不是计划分钟（I-2）。一旦在查询/服务层把它们求和，就会出现第二套「今日总分钟」，
 * 而它与 `ΣPlanTask.plannedMinutes` 必然对不上 —— 用户看到的两个数字都是「计划的」。
 *
 * 只做文本扫描（便宜、能覆盖所有聚合写法），两条模式：
 * - `_sum: { estMinutes / suggestedMinutes }`（Prisma 聚合）
 * - `reduce(...)` 回调里直接加 `x.estMinutes / x.suggestedMinutes`
 *
 * 白名单文件必须写清「这里的 estMinutes 不是 `TaskCandidate` 的」。
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
    const full = join(ROOT, dirName);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // 目录不存在时跳过（重建工程时测试仍可运行）
    }
  }
  return out;
}

/** 命中位置（行号 + 片段），用于失败信息与白名单僵尸断言。 */
function findCandidateSums(source: string): number[] {
  const lines: number[] = [];
  const sumPattern = /_sum\s*:\s*\{[^}]*\b(estMinutes|suggestedMinutes)\b/gs;
  for (const match of source.matchAll(sumPattern)) {
    lines.push(source.slice(0, match.index ?? 0).split('\n').length);
  }
  const reducePattern = /\.reduce\(/g;
  for (const match of source.matchAll(reducePattern)) {
    const windowStart = match.index ?? 0;
    const windowText = source.slice(windowStart, windowStart + 400);
    // 只认「加法里出现 estMinutes」：`.map(row => ({ estMinutes: … }))` 这类
    // 载入 DTO 的写法不该被当成求和（它没有 `+`）。
    // 字符集含 `,`，否则 `total + Math.max(0, item.estMinutes)` 会漏检 ——
    // 那正是 reviews.ts 里的真实求和，漏了就等于给任何包一层函数调用的求和开天窗。
    if (/\+\s*[\w.?()[\]"'\s,]{0,60}\.\s*(estMinutes|suggestedMinutes)\b/.test(windowText)) {
      lines.push(source.slice(0, windowStart).split('\n').length);
    }
  }
  return lines;
}

/**
 * 白名单：这里的 `estMinutes` 是 `ReviewTask`（v2.0 复习任务的预计准备分钟），
 * 不是 v2.7 的 `TaskCandidate.estMinutes`，且不进入任何「计划/实际」口径。
 */
const ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: 'src/lib/queries/reviews.ts',
    reason: 'ReviewTask.estMinutes（v2.0 复习任务的预计准备分钟），与 TaskCandidate 无关',
  },
];

describe('G-2 查询/服务层不得聚合候选预计分钟', () => {
  it('queries/** 与 services/** 没有 estMinutes / suggestedMinutes 求和', () => {
    const files = [...listTsFiles('src/lib/queries'), ...listTsFiles('src/lib/services')];
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));
    const violations: string[] = [];

    for (const file of files) {
      const hits = findCandidateSums(readFileSync(join(ROOT, file), 'utf8'));
      if (hits.length === 0) continue;
      if (allowed.has(file)) continue;
      violations.push(`${file}:${hits.join(',')}`);
    }

    expect(violations, '候选预计分钟只能计数，不能求和当成计划分钟').toEqual([]);
  });

  it('白名单无僵尸条目（规则命中已消失时必须同步删条目）', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file} 必须写清原因`).toBeGreaterThan(6);
      const hits = findCandidateSums(readFileSync(join(ROOT, entry.file), 'utf8'));
      expect(hits.length, `白名单僵尸：${entry.file} 已不再命中聚合模式`).toBeGreaterThan(0);
    }
  });
});