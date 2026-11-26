/**
 * G-4 `SkillGap` 查询必须显式带 `dimensionKind`（T10）。
 *
 * 官方四项（LISTENING/READING/SPEAKING/WRITING）与辅助维度（GRAMMAR/VOCABULARY/
 * SENTENCE_STRUCTURE）共用 `SkillGap` 一张表。忘写 `dimensionKind` 时：
 *
 * - 四技能配比会多出第 5、6、7 项，合计 ≠ 100%；
 * - 弱项排序会被语法/词汇淹没 —— 而且**不报错**，页面照样渲染。
 *
 * 所以用文本扫描守门（Prisma 的 where 是对象字面量，正则能稳定看到）。唯一的
 * 白名单是「按 snapshotId 建 gapId 反查表」：它要拿到**所有**维度才能把候选的
 * `skillGapKey` 映射成 id，过滤反而会让辅助维度的 `skillGapId` 永远为 null。
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
  walk(dir);
  return out;
}

/** 从 `{` 位置起做括号配对，返回对象字面量文本（不含外层花括号）。 */
function braceBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

/**
 * 每个 `prisma/tx.skillGap.findMany(` 调用点：只看 `where: { … }` 块里有没有
 * `dimensionKind`。**不能看整段 600 字符** —— `select: { dimensionKind: true }`
 * 会提供假阴性（字段被读出来，但没过滤）。
 */
function findUnfilteredGapQueries(source: string): number[] {
  const unfiltered: number[] = [];
  const pattern = /\b(?:prisma|tx)\.skillGap\.findMany\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const after = source.slice(start, start + 500);
    const whereMatch = /\bwhere\s*:\s*\{/.exec(after);
    const line = source.slice(0, start).split('\n').length;
    if (!whereMatch) {
      unfiltered.push(line);
      continue;
    }
    const openIndex = start + whereMatch.index + whereMatch[0].length - 1;
    if (!/\bdimensionKind\b/.test(braceBlock(source, openIndex))) unfiltered.push(line);
  }
  return unfiltered;
}

/**
 * 白名单：快照落库时的 `skillGapId` 反查（需要全部维度）。
 * 过滤 OFFICIAL 会让辅助维度候选的 `skillGapId` 恒为 null —— 解释面板就断链。
 */
const ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: 'src/lib/services/planningSnapshot.ts',
    reason: '按 snapshotId 建全维度 gapId 反查表（要同时映射 OFFICIAL 与 AUXILIARY）',
  },
];

describe('G-4 SkillGap 查询带维度过滤', () => {
  it('src/lib 下没有「漏 dimensionKind 的 skillGap.findMany」', () => {
    const files = listTsFiles(join(ROOT, 'src/lib'));
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));
    const violations: string[] = [];

    for (const file of files) {
      const hits = findUnfilteredGapQueries(readFileSync(join(ROOT, file), 'utf8'));
      if (hits.length === 0) continue;
      if (allowed.has(file)) continue;
      violations.push(`${file}:${hits.join(',')}`);
    }

    expect(violations, '缺口查询漏 dimensionKind：辅助维度会混进四技能分母').toEqual([]);
  });

  it('白名单无僵尸条目', () => {
    for (const entry of ALLOWLIST) {
      const hits = findUnfilteredGapQueries(readFileSync(join(ROOT, entry.file), 'utf8'));
      expect(hits.length, `白名单僵尸：${entry.file} 已不再命中`).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(6);
    }
  });
});