/**
 * T09 import 边界不变量（G-5 / G-7，验收 ⑩–⑮）。
 *
 * 三条边界：
 * - ⑩ `readiness.ts` 不 import `stageGate`，`stageGate.ts` 不 import `readiness`
 *   （两个结论源互不引用对方的结论）；
 * - ⑪ `READY_FOR_REVIEW` 字面量只出现在白名单文件（domain 定义 + 其测试）；
 * - ⑫–⑮ G-5③：`components/**` 里 `from '@/lib/queries/*'` 的**值导入**即失败、
 *   `import type` 通过。用 TypeScript Compiler API 判 `isTypeOnly`，**不用逐行 grep**
 *   （逐行版对多行 import 会同时误报与漏报）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** 递归列出某目录下所有 `.ts` / `.tsx` 文件（相对 ROOT 的路径，POSIX 分隔）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push(relative(ROOT, full).split('\\').join('/'));
      }
    }
  };
  walk(dir);
  return out;
}

/** 解析一段源码里所有 `import ... from '@…'` 的模块说明符。 */
function importSpecifiers(sourceText: string): string[] {
  const sf = ts.createSourceFile('x.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    out.push(stmt.moduleSpecifier.text);
  }
  return out;
}

/** 该 import 是否是纯类型导入（整句 `import type` 或所有具名绑定都 `type`）。 */
function isTypeOnlyImport(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause;
  if (!clause) return true; // 副作用导入没有绑定，不算「值导入」
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.every((element) => element.isTypeOnly);
  }
  // 默认导入（无 isTypeOnly）是值导入
  return false;
}

/** 找出从 `@/lib/queries/*` 的**值导入**（`import type` 与内联 `type` 绑定不算）。 */
function valueImportsFromQueries(sourceText: string, isTsx: boolean): Array<{ line: number; specifier: string }> {
  const sf = ts.createSourceFile(
    isTsx ? 'x.tsx' : 'x.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Array<{ line: number; specifier: string }> = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.moduleSpecifier.text.startsWith('@/lib/queries/')) continue;
    if (isTypeOnlyImport(stmt)) continue;
    const line = sf.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
    out.push({ line, specifier: stmt.moduleSpecifier.text });
  }
  return out;
}

describe('⑫–⑮ G-5③：queries 值导入判定的多行感知（Compiler API，非逐行 grep）', () => {
  it('⑬ 多行 import type 不报', () => {
    const src = [
      "import type {",
      "  resolveSourceBadge,",
      "  resolveConfidenceBadge,",
      "} from '@/lib/queries/planner';",
      '',
    ].join('\n');
    expect(valueImportsFromQueries(src, true)).toEqual([]);
  });

  it('⑭ 多行值导入要报', () => {
    const src = [
      'import {',
      '  resolveSourceBadge',
      "} from '@/lib/queries/planner';",
      '',
    ].join('\n');
    expect(valueImportsFromQueries(src, true)).toHaveLength(1);
  });

  it('⑮ 单行值导入要报', () => {
    const src = "import { resolveSourceBadge } from '@/lib/queries/planner';\n";
    expect(valueImportsFromQueries(src, true)).toHaveLength(1);
  });

  it('内联 type 绑定（import { type X }）不算值导入', () => {
    const src = "import { type PlannerRow } from '@/lib/queries/planner';\n";
    expect(valueImportsFromQueries(src, true)).toEqual([]);
  });
});

describe('⑫ G-5③：components/** 实际扫描', () => {
  it('components/** 不存在 queries 值导入，也不 import prisma/PrismaClient', () => {
    const componentFiles = listSourceFiles(join(SRC, 'components'));
    expect(componentFiles.length).toBeGreaterThan(0);

    for (const file of componentFiles) {
      const sourceText = readFileSync(join(ROOT, file), 'utf8');
      const hits = valueImportsFromQueries(sourceText, file.endsWith('.tsx'));
      expect(hits, `${file} 不得值导入 @/lib/queries/*`).toEqual([]);
      expect(sourceText).not.toContain("from '@/lib/prisma'");
      expect(sourceText).not.toContain('PrismaClient');
    }
  });
});

describe('⑩ readiness 与 stageGate 互不 import', () => {
  it('readiness.ts 不 import stageGate', () => {
    const src = readFileSync(join(SRC, 'lib/domain/readiness.ts'), 'utf8');
    const specifiers = importSpecifiers(src);
    expect(specifiers.filter((spec) => spec.includes('stageGate'))).toEqual([]);
  });

  it('stageGate.ts 不 import readiness', () => {
    const src = readFileSync(join(SRC, 'lib/domain/stageGate.ts'), 'utf8');
    const specifiers = importSpecifiers(src);
    expect(specifiers.filter((spec) => spec.includes('readiness'))).toEqual([]);
  });
});

describe('⑪ G-7：READY_FOR_REVIEW 字面量只出现在白名单文件', () => {
  const WHITELIST = new Set([
    'src/lib/domain/readiness.ts',
    'src/lib/domain/__tests__/readiness.test.ts',
    'src/lib/__tests__/ac/readiness.test.ts',
    // 本文件自身断言该字面量，必然包含它；与「哪些实现文件能产出结论」是两回事。
    'src/lib/__tests__/invariants/importBoundary.test.ts',
  ]);

  it('结论字面量只在 domain 定义与其测试里出现', () => {
    const files = listSourceFiles(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      if (WHITELIST.has(file)) continue;
      const sourceText = readFileSync(join(ROOT, file), 'utf8');
      if (sourceText.includes('READY_FOR_REVIEW')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
