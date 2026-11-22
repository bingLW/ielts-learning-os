/**
 * E-05 用例矩阵：词条归一的**字符级等价变形**（T12 §1）。
 *
 * 这个文件存在的理由：词条身份键是「同一个词」的唯一判据。归一化差一个字符，
 * 主库与候选就会对同一个词给出两个键，E-04「已存在词条只加来源」失效，
 * 词库开始安静地长重复词条 —— 没有报错、没有日志，只有越来越多的重复。
 *
 * 三条硬要求：
 * 1. **矩阵逐条覆盖**：大小写、连字符、重音（NFC/NFD）、弯引号、首尾空白、
 *    词尾句点、全角字符、零宽字符；
 * 2. **纯 ASCII 输入逐字不变**：T12 扩展了 `normalizeLemma`，但**不允许**改变
 *    任何 ASCII 输入的输出 —— 库里已有词条的键不能被改写（回归用例在 §2）；
 * 3. **不做词形还原**：`running` 必须还是 `running`，那是词典的职责。
 */

import { describe, expect, it } from 'vitest';
import {
  buildContextHash,
  candidateKeyOf,
  CONTEXT_HASH_LENGTH,
  isNormalizationDrift,
  legacyLemmaKeyVariants,
  legacyNormalizeLemma,
  normalizeMaterialLemma,
} from '../lemmaNormalize';
import { normalizeLemma } from '../vocabImport';

// ═════════════════════ ① E-05 矩阵（normalizeLemma） ═════════════════════

interface MatrixCase {
  label: string;
  input: string;
  expected: string;
}

const MATRIX: MatrixCase[] = [
  { label: '大小写', input: 'Well-Known', expected: 'well-known' },
  { label: '全大写', input: 'PERSEVERE', expected: 'persevere' },
  { label: '连字符（保留）', input: 'well-known', expected: 'well-known' },
  { label: '重音 NFC（合成形式）', input: 'café', expected: 'café' },
  // NFD：`e` + U+0301。肉眼与 café 完全相同，但字节不同 —— 旧实现会生成两个词条。
  { label: '重音 NFD（分解形式）', input: 'cafe\u0301', expected: 'café' },
  { label: '分音符', input: 'naïve', expected: 'naïve' },
  // 弯撇号：PDF 抽取里几乎全是 U+2019，而词库导入多半是 ASCII 撇号。
  { label: '弯撇号 → ASCII', input: 'don\u2019t', expected: "don't" },
  { label: '两端弯引号（剥掉）', input: '\u201Cquote\u201D', expected: 'quote' },
  { label: '首尾空白', input: '  hello  ', expected: 'hello' },
  { label: '词中多空格', input: 'take   off', expected: 'take off' },
  { label: '全角空格', input: 'take\u3000off', expected: 'take off' },
  { label: '零宽字符（PDF 噪声）', input: 'qu\u200Bick', expected: 'quick' },
  { label: '全角字母', input: '\uFF43\uFF41\uFF46\uFF45', expected: 'cafe' },
  // 词尾句点**不在** normalizeLemma 的职责里（会改变 ASCII 输出，见 §2），
  // 由材料侧的 normalizeMaterialLemma 处理（见 §3）。
  { label: '词尾句点（原样保留）', input: 'hello.', expected: 'hello.' },
];

describe('E-05 矩阵：normalizeLemma 的字符级等价变形', () => {
  for (const testCase of MATRIX) {
    it(`${testCase.label}：${JSON.stringify(testCase.input)} → ${JSON.stringify(testCase.expected)}`, () => {
      expect(normalizeLemma(testCase.input)).toBe(testCase.expected);
    });
  }

  it('同一组等价形式必须归一到同一个键（归一的全部意义）', () => {
    const pairs: Array<[string, string]> = [
      ['café', 'cafe\u0301'],
      ["don't", 'don\u2019t'],
      ['quick', 'qu\u200Bick'],
      ['cafe', '\uFF43\uFF41\uFF46\uFF45'],
      ['ice cream', 'ice\u00A0cream'],
    ];
    for (const [left, right] of pairs) {
      expect(normalizeLemma(left), `${left} 与 ${right} 应同键`).toBe(normalizeLemma(right));
    }
  });
});

// ═════════════════════ ② 纯 ASCII 回归（键不可被改写） ═════════════════════

describe('纯 ASCII 输入输出逐字不变（保护库里已有词条键）', () => {
  /**
   * 这些期望值是 **T12 之前** 的实现产出的字面量，逐字抄下来。
   *
   * 为什么必须逐字：`VocabularyItem.normalizedLemma` 是唯一键的一部分。改一个
   * 字符，全库同名词条就都变成"查不到"，于是会新建一条重复词条。
   */
  const ASCII_CASES: Array<[string, string]> = [
    ['hello', 'hello'],
    ['  HELLO  ', 'hello'],
    ["don't", "don't"],
    ['well-known', 'well-known'],
    ['take  off', 'take off'],
    ['U.S.A.', 'u.s.a.'],
    ['"quoted"', 'quoted'],
    ['a-b_c', 'a-b_c'],
    ['ICE   cream', 'ice cream'],
    ['bank', 'bank'],
  ];

  for (const [input, expected] of ASCII_CASES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeLemma(input)).toBe(expected);
    });
  }

  it('ASCII 输入里不含任何非 ASCII 字符时，输出也全是 ASCII', () => {
    for (const [input] of ASCII_CASES) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(normalizeLemma(input)), input).toBe(true);
    }
  });
});

// ═════════════════════ ③ 材料侧清洗（normalizeMaterialLemma） ═════════════════════

describe('normalizeMaterialLemma：只在两端剥标点，不做词形还原', () => {
  it('引号 + 标点尾巴都剥掉（AI 摘词最常见的形态）', () => {
    expect(normalizeMaterialLemma('"quick,"')).toBe('quick');
    expect(normalizeMaterialLemma('quick.')).toBe('quick');
    expect(normalizeMaterialLemma('(quick)')).toBe('quick');
    expect(normalizeMaterialLemma('  “persevere”  ')).toBe('persevere');
    expect(normalizeMaterialLemma('take off!')).toBe('take off');
  });

  it('中间字符一个都不动（连字符、撇号、空格）', () => {
    expect(normalizeMaterialLemma('well-known')).toBe('well-known');
    expect(normalizeMaterialLemma("don't")).toBe("don't");
    expect(normalizeMaterialLemma('take off')).toBe('take off');
  });

  it('不做词形还原：running 就是 running', () => {
    expect(normalizeMaterialLemma('Running')).toBe('running');
    expect(normalizeMaterialLemma('ran')).toBe('ran');
  });

  it('与 normalizeLemma 共用同一套字符归一（不是第二套）', () => {
    expect(normalizeMaterialLemma('don\u2019t')).toBe("don't");
    expect(normalizeMaterialLemma('cafe\u0301')).toBe('café');
  });

  it('全是标点/空白时返回空串（调用方应视为「没有词条」）', () => {
    expect(normalizeMaterialLemma('')).toBe('');
    expect(normalizeMaterialLemma('   ')).toBe('');
    expect(normalizeMaterialLemma('...')).toBe('');
    expect(normalizeMaterialLemma('"—"')).toBe('');
    expect(normalizeMaterialLemma('\u201C\u201D')).toBe('');
  });

  it('非字符串输入不炸（payload 是自由 JSON，脏数据必须能容忍）', () => {
    expect(normalizeMaterialLemma(undefined as unknown as string)).toBe('');
    expect(normalizeMaterialLemma(null as unknown as string)).toBe('');
  });
});

// ═════════════════════ ④ 上下文去重键（E-02） ═════════════════════

describe('buildContextHash：E-02 去重键', () => {
  const sentence = 'Reading is a skill that improves with deliberate practice.';

  it('长度固定 16 位十六进制', () => {
    expect(buildContextHash(sentence)).toHaveLength(CONTEXT_HASH_LENGTH);
    expect(buildContextHash(sentence)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('同一句稳定（幂等）', () => {
    expect(buildContextHash(sentence)).toBe(buildContextHash(sentence));
  });

  it('排版噪声不算不同：大小写/多空格/全角半角/零宽 都产出同一个键', () => {
    const base = buildContextHash(sentence);
    expect(buildContextHash(sentence.toUpperCase())).toBe(base);
    expect(buildContextHash(sentence.replace(/ /g, '   '))).toBe(base);
    expect(buildContextHash(`  ${sentence}\u200B  `)).toBe(base);
    // NFKC：全角标点与半角标点等价（normalizeForVerify 的规则）
    expect(buildContextHash(sentence.replace(/\.$/, '．'))).toBe(base);
  });

  it('不同的句子必须是不同的键（否则两处原文会被去重成一条）', () => {
    expect(buildContextHash(sentence)).not.toBe(
      buildContextHash('Vocabulary breadth predicts comprehension more strongly than grammar.'),
    );
  });

  it('空句也有稳定键（不抛错），但调用方本不该拿空句建候选', () => {
    expect(buildContextHash('')).toHaveLength(CONTEXT_HASH_LENGTH);
  });
});

// ═════════════════════ ⑤ 候选身份键 ═════════════════════

describe('candidateKeyOf：与 VocabularyCandidate 唯一约束同构', () => {
  it('词性/义项不同 → 键不同（同形异义不合并）', () => {
    expect(candidateKeyOf('bank', 'n', 'default')).not.toBe(candidateKeyOf('bank', 'v', 'default'));
    expect(candidateKeyOf('bank', 'n', 'financial')).not.toBe(
      candidateKeyOf('bank', 'n', 'riverbank'),
    );
  });

  it('空词性与未知词性是两个键（空串 = 未知，沿用主库约定）', () => {
    expect(candidateKeyOf('quick', '', 'default')).toBe('quick||default');
    expect(candidateKeyOf('quick', 'adj', 'default')).toBe('quick|adj|default');
  });
});

// ═════════════════════ ⑥ 历史归一化键（§A 数据债） ═════════════════════

describe('legacyNormalizeLemma：T12 之前那版算法（只用于读兼容）', () => {
  it('对纯 ASCII 与新算法完全一致（旧库里的 ASCII 键本来就是对的）', () => {
    for (const raw of ['hello', '  HELLO  ', "don't", 'well-known', '"quoted"', 'ICE   cream']) {
      expect(legacyNormalizeLemma(raw)).toBe(normalizeLemma(raw));
    }
  });

  it('对新算法折叠的那四类字符，旧键与新键不同（这正是"漂移"的定义）', () => {
    expect(legacyNormalizeLemma('don\u2019t')).toBe('don\u2019t');
    expect(normalizeLemma('don\u2019t')).toBe("don't");
    expect(legacyNormalizeLemma('cafe\u0301')).not.toBe(normalizeLemma('cafe\u0301'));
    expect(legacyNormalizeLemma('\uFF43\uFF41\uFF46\uFF45')).toBe('\uFF43\uFF41\uFF46\uFF45');
  });
});

describe('legacyLemmaKeyVariants：把等价拼写的旧键都摆出来', () => {
  it('ASCII 撇号的候选能反查出弯撇号的历史键（这是兜底匹配的关键）', () => {
    expect(legacyLemmaKeyVariants("don't")).toContain('don\u2019t');
  });

  it('弯撇号的候选也能反查出 ASCII 旧键（双向都要成立）', () => {
    expect(legacyLemmaKeyVariants('don\u2019t')).toContain("don't");
  });

  it('全角 / NFD 的历史键能反查出来', () => {
    expect(legacyLemmaKeyVariants('cafe')).toContain('\uFF43\uFF41\uFF46\uFF45');
    expect(legacyLemmaKeyVariants('café')).toContain('cafe\u0301');
  });

  it('空输入返回空数组（不抛错、不返回 [""]）', () => {
    expect(legacyLemmaKeyVariants('')).toEqual([]);
    expect(legacyLemmaKeyVariants('   ')).toEqual([]);
  });

  it('结果确定（同样输入两次逐字相同）、且不含空串', () => {
    const a = legacyLemmaKeyVariants("it's");
    const b = legacyLemmaKeyVariants("it's");
    expect(a).toEqual(b);
    expect(a.every((key) => key.length > 0)).toBe(true);
  });
});

describe('isNormalizationDrift：只判定，不修复', () => {
  it('键与当前算法一致 → false', () => {
    expect(isNormalizationDrift({ lemma: 'Café', normalizedLemma: 'café' })).toBe(false);
    expect(isNormalizationDrift({ lemma: "don't", normalizedLemma: "don't" })).toBe(false);
  });

  it('键是旧算法算出来的 → true', () => {
    expect(isNormalizationDrift({ lemma: 'don\u2019t', normalizedLemma: 'don\u2019t' })).toBe(true);
    expect(isNormalizationDrift({ lemma: 'cafe\u0301', normalizedLemma: 'cafe\u0301' })).toBe(true);
  });

  it('脏数据不炸：空串/缺字段一律按"没漂移"处理，避免页面被一条烂数据打成 500', () => {
    expect(isNormalizationDrift({ lemma: '', normalizedLemma: '' })).toBe(false);
  });
});
