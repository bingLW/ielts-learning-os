/**
 * G-15 `domain/**` 的导出函数必须自己守住输入（T10，`41 §1.9 A-4`）。
 *
 * **触发集按危险属性定义，不按「看起来像强转」**：
 *
 *   危险属性 = 「非 `number` 输入 → 有限的 `number` 输出」。
 *
 * 满足者只有 `Number(x)`、一元 `+x`、`~~x`、`x | 0`、`x >> 0` —— 它们把 `null` /
 * `''` / 缺字段**假装成 0**，于是「没有这一维」在排序里变成「这一维最差」。
 *
 * **刻意排除 `parseInt` / `parseFloat`**：它们给的是 `NaN` 而不是 0，`NaN` 会被
 * `Number.isFinite` 抓出来，失效方式完全不同。将来遇到 `BigInt(x)`、`Math.trunc(x)`
 * 的问法是同一句：「它会不会把脏输入伪装成合法数值？」
 *
 * ── 三处盲区（这不是证明，是绊线）──────────────────────────────────────
 * ① 只盖得住「函数体里没写守卫」这一种；
 * ② 盖不住「守卫在、但守错了对象」（`typeof a` 之后去 `Number(b)`）；
 * ③ **盖不住「函数体里根本没有强转，脏值从装配处进来」** —— C-I 就是这种形状：
 *    `Object.fromEntries([...minListening…])` 一行强转都没有，`null` 由构造过程
 *    带进 `Record<string, number>`，扫描完全看不见。
 *
 * 真正的证明是行为测试（T02 ⑯ / T04 ⑳），本文件不可替代它们。
 * 另外也不扫非空断言 `!`：它的失效方式是「对 null 撒谎」，补救是显式空值判断，
 * 不是 `typeof`；`!` 由 `strict` + review 管。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = process.cwd();
const DOMAIN_DIR = join(ROOT, 'src', 'lib', 'domain');

function listDomainFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(relative(ROOT, full).split('\\').join('/'));
      }
    }
  };
  walk(dir);
  return out;
}

interface CoercionHit {
  file: string;
  fn: string;
  line: number;
  guarded: boolean;
}

/** 遍历函数体（含嵌套块）找危险强转。 */
function findCoercions(fn: ts.FunctionDeclaration): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Number') {
      hits.push(node);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken) {
      // 一元 +："+x"；"++x" 是 PlusPlusToken，不会命中这里
      hits.push(node);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.TildeToken) {
      // ~~x：两层按位取反才会截断成整数
      if (
        ts.isPrefixUnaryExpression(node.operand) &&
        node.operand.operator === ts.SyntaxKind.TildeToken
      ) {
        hits.push(node);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const zero = ts.isNumericLiteral(node.right) && node.right.text === '0';
      if (zero && (op === ts.SyntaxKind.BarToken || op === ts.SyntaxKind.GreaterThanGreaterThanToken)) {
        hits.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return hits;
}

/** 同一函数体内是否有类型守卫（`typeof` / `Number.isFinite` / `Number.isInteger` / `Array.isArray`）。 */
function hasGuard(fn: ts.FunctionDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeOfExpression(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'Number' &&
        (expr.name.text === 'isFinite' || expr.name.text === 'isInteger')
      ) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'Array' &&
        expr.name.text === 'isArray'
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function isExported(fn: ts.FunctionDeclaration): boolean {
  return Boolean(fn.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * 白名单：每条都必须同时说明「为什么脏输入在这里不会伪装成 0」。
 * 断言无僵尸：函数被删/改名后必须同步删条目。
 */
const ALLOWLIST: { file: string; fn: string; reason: string }[] = [];

function collectHits(): CoercionHit[] {
  const hits: CoercionHit[] = [];
  for (const file of listDomainFiles(DOMAIN_DIR)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.body || !stmt.name || !isExported(stmt)) continue;
      const coercions = findCoercions(stmt);
      if (coercions.length === 0) continue;
      hits.push({
        file,
        fn: stmt.name.text,
        line: sf.getLineAndCharacterOfPosition(coercions[0].getStart()).line + 1,
        guarded: hasGuard(stmt),
      });
    }
  }
  return hits;
}

describe('G-15 domain 导出函数的危险强转必须配守卫', () => {
  it('没有「未进白名单又没守卫」的强转', () => {
    const hits = collectHits();
    const allowed = new Set(ALLOWLIST.map((entry) => `${entry.file}#${entry.fn}`));
    const violations = hits
      .filter((hit) => !hit.guarded && !allowed.has(`${hit.file}#${hit.fn}`))
      .map((hit) => `${hit.file}:${hit.line} ${hit.fn}()`);

    expect(
      violations,
      '这些函数把非 number 输入变成了有限的 number：要么加守卫，要么写进白名单并说明原因',
    ).toEqual([]);
  });

  it('白名单无僵尸条目', () => {
    const hits = collectHits();
    const observed = new Set(hits.map((hit) => `${hit.file}#${hit.fn}`));
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file}#${entry.fn} 必须写清原因`).toBeGreaterThan(6);
      expect(
        observed.has(`${entry.file}#${entry.fn}`),
        `白名单僵尸：${entry.file}#${entry.fn} 已不再出现危险强转`,
      ).toBe(true);
    }
  });
});