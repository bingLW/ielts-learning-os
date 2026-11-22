/**
 * 材料侧的词条归一（T12，E-02 / E-05）。
 *
 * **这是薄封装，不是第二套归一化。**
 *
 * 项目里已经有 `domain/vocabImport.ts` 的 `normalizeLemma()`，v2.3 的词库导入
 * （`VocabularyItem.normalizedLemma`）就是它算的。材料词汇候选如果另写一份，
 * 同一个词在主库与候选里就会得到两个不同的键，E-04「已存在词条只加来源」
 * 直接失效 —— 词库会开始长重复词条，而这种重复不会报错，只会安静地变多。
 *
 * 所以本文件只做两件 `normalizeLemma()` **不该**做的事：
 *
 * 1. **材料侧清洗**（`normalizeMaterialLemma`）：剥掉词条两端的标点/引号/空白。
 *    AI 从原文里摘出来的词经常带尾巴：`"quick,"`、`quick.`、`(quick)`。
 *    这些是**引用噪声**，不是词的一部分。
 *    刻意**不做词形还原**（running → run）：那是词典的职责，做了会让「候选人
 *    确认这是 running 而不是 run」失去意义，也会让 `senseKey` 语义塌陷。
 * 2. **上下文去重键**（`buildContextHash`）：E-02 要求「同一个词在不同句子里是
 *    不同候选」，去重键取句子的归一化哈希，而归一化复用 `sourceVerify` 的
 *    `normalizeForVerify()` —— 与原文回验用同一套等价规则，否则会出现
 *    「回验认为两句相同、去重认为不同」的自相矛盾。
 */

import { createHash } from 'node:crypto';
import { normalizeForVerify } from '@/lib/materials/sourceVerify';
import { normalizeLemma } from './vocabImport';

/**
 * 上下文哈希长度（E-02）。
 *
 * 16 位十六进制 = 64 bit，在这个量级（单材料上百条候选）碰撞概率可以忽略，
 * 又比 64 位短一半、肉眼可读、日志里不占地方。
 */
export const CONTEXT_HASH_LENGTH = 16;

/**
 * 词条两端要剥掉的字符集合。
 *
 * 用**集合 + 逐字扫描**而不是正则字符类：字符类里 `[` `]` `\` `-` 都要转义，
 * 写错一个就会静默地少剥或多剥（而这类错误只会在某个词的键上体现，很难发现）。
 *
 * 引号单独列一遍是因为 `normalizeLemma()` 只剥「首尾全是引号」的情形；
 * 这里的输入可能已经被它剥过一轮，也可能是 `"quick",` 这种引号+逗号的组合。
 *
 * 连字符在集合里：`-ing` 这种边角输入剥掉更安全（`well-known` 的连字符在中间，
 * 不受影响）。斜杠/竖线/括号同理，都只在**两端**生效。
 */
const EDGE_PUNCTUATION = new Set(
  '.,;:!?…·—–-_/\\|()[]{}<>*#@&+~^%$"\'`'.split(''),
);

/** 逐字剥掉两端的标点/引号（中间的一个都不动）。 */
function trimEdgePunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_PUNCTUATION.has(value[start])) start += 1;
  while (end > start && EDGE_PUNCTUATION.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/**
 * 剥掉两端标点，**保留大小写**。
 *
 * 用途：用户手改词条时（`reviewVocabularyCandidateAction` 的 `edited` 分支），
 * 既要用它算归一化键（小写），又要拿它当展示用的 `lemma`（保留用户输入的大小写）。
 * 两处共用同一个剥离规则 —— 否则会出现「键是 quick、显示是 "quick,"」这种
 * 看着像两个词的东西。
 *
 * @param raw 任意输入
 */
export function stripLemmaEdgePunctuation(raw: string): string {
  if (typeof raw !== 'string') return '';
  return trimEdgePunctuation(raw.trim()).trim();
}

/**
 * 材料侧词条归一：`normalizeLemma()` + 去两端标点。
 *
 * @param raw AI 给出的 lemma（可能带引号、逗号、括号）
 * @returns 归一后的词条键；输入全是标点/空白时返回空串（调用方应视为「没有词条」）
 */
export function normalizeMaterialLemma(raw: string): string {
  if (typeof raw !== 'string') return '';
  const base = normalizeLemma(raw);
  if (base.length === 0) return '';
  return stripLemmaEdgePunctuation(base);
}

/**
 * 上下文去重键（E-02）：`sha256(normalizeForVerify(sentence))` 前 16 位。
 *
 * 为什么复用 `normalizeForVerify`：它已经把「连续空格、全角半角、零宽字符、
 * 大小写」折平了。若这里换一套规则，同一句话可能"回验通过但哈希不同"，
 * 于是同一处原文被 AI 抽两次会产生两条候选（AC-10 要防的正是这个）。
 *
 * @param sentence 原文上下文句（通常是 `sourceQuote`，已通过回验）
 */
export function buildContextHash(sentence: string): string {
  const normalized = normalizeForVerify(sentence ?? '');
  return createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, CONTEXT_HASH_LENGTH);
}

// ───────────────────── 历史归一化键（normalization drift） ─────────────────────

/**
 * **旧算法**的归一化（T12 之前的 `normalizeLemma`，逐字复刻）。
 *
 * 为什么需要留着它：`normalizeLemma` 在 T12 加了 NFD→NFC / 零宽折叠 / 全角折叠 /
 * 弯引号折叠，而 v2.3 起库里的 `VocabularyItem.normalizedLemma` 全是**旧算法**算的。
 * 键不会自动更新（那是用户数据），于是「同一个词在库里一个键、在候选里另一个键」。
 *
 * 这个函数只用于**读兼容**：拼出「旧算法可能算出的键」，拿它去索引列上探一次。
 * 绝不用它写库、绝不用它替换 `normalizeLemma`。
 *
 * @param raw 任意输入
 */
export function legacyNormalizeLemma(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 单引号类字符（旧算法**不**折叠它们，所以库里可能原样留着）。 */
const APOSTROPHE_FORMS = ["'", '\u2019', '\u2018', '\u02BC', '\u2032'] as const;

/** 双引号类字符。 */
const QUOTE_FORMS = ['"', '\u201C', '\u201D', '\u2033'] as const;

/**
 * 把 ASCII 逐字映射成全角（U+FF01–U+FF5E）。
 *
 * 与 `normalizeLemma` 里的折叠互为逆运算 —— 旧库里可能有全角词条，
 * 用它反推「那个词条的旧键长什么样」。
 */
function toFullWidth(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : ch;
  }
  return out;
}

/**
 * 枚举「与 `raw` 等价的其它拼写形式」，并给出它们各自的**旧键**。
 *
 * 为什么要枚举而不是只算 `legacyNormalizeLemma(raw)`：库里那条历史词条的原文
 * 可能与候选的词条**字形不同但语义同一**。最典型的例子是弯撇号：
 * 候选 `don't`（ASCII）与库里 `don’t`（U+2019）是两个字符串，旧键也不同，
 * 只按候选自己的旧键去查永远查不到。
 *
 * 枚举的四种维度正好对应 `normalizeLemma` 新增的四条折叠：
 * 撇号形式、双引号形式、全角、Unicode 组合形式（NFC/NFD）。
 * 上限 5×4×2×2 = 80 个候选键，实际远少于此，一次 `IN` 查询即可。
 *
 * @param raw 候选的**原始**词条（大小写原样）
 * @returns 去重后的旧键列表（顺序确定，便于断言）
 */
export function legacyLemmaKeyVariants(raw: string): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  const seeds = new Set<string>([raw]);
  for (const seed of Array.from(seeds)) {
    for (const apostrophe of APOSTROPHE_FORMS) {
      if (seed.includes("'")) seeds.add(seed.split("'").join(apostrophe));
      if (seed.includes(apostrophe)) seeds.add(seed.split(apostrophe).join("'"));
    }
    for (const quote of QUOTE_FORMS) {
      if (seed.includes('"')) seeds.add(seed.split('"').join(quote));
      if (seed.includes(quote)) seeds.add(seed.split(quote).join('"'));
    }
    // 已是全角/半角的两种形态都放进来（互逆映射，两侧都试一遍更稳）
    seeds.add(toFullWidth(seed));
    seeds.add(toFullWidth(seed).normalize('NFD'));
    seeds.add(seed.normalize('NFD'));
    seeds.add(seed.normalize('NFC'));
  }

  const keys = new Set<string>();
  for (const seed of seeds) {
    const key = legacyNormalizeLemma(stripLemmaEdgePunctuation(seed));
    if (key.length > 0) keys.add(key);
  }
  return Array.from(keys).sort();
}

/**
 * 这条词条的 `normalizedLemma` 是不是**旧版本算法**算出来的？
 *
 * 判据只有一句话：拿当前算法重算一遍，看是否与库里存的一致。
 * 不一致 = 该词条建于 T12 之前（或由外部脚本写入），它的键停在旧空间里。
 *
 * **不要自动修复它**：`normalizedLemma` 是身份键，改它等于改词条身份，
 * 会牵动唯一约束、卡片关联、外部映射。同步时用「按原词形兜底匹配」绕开即可，
 * 把"要不要重算"留给用户/后续迁移。
 *
 * @param item 至少含 `lemma` 与 `normalizedLemma`
 */
export function isNormalizationDrift(item: {
  lemma: string;
  normalizedLemma: string;
}): boolean {
  const expected = normalizeLemma(item.lemma ?? '');
  return expected !== (item.normalizedLemma ?? '');
}

/**
 * 词条身份键（与 `VocabularyCandidate` 的唯一约束同构，也便于做内存 Map 的键）。
 *
 * 与 `vocabularyKey()` 的区别：那个带 `language` 前缀用于主库，这个只用于
 * 候选表内部的去重（候选表的唯一键不含 language —— 一期材料只有英语）。
 *
 * @param normalizedLemma 已归一化的词条
 * @param pos 词性（空串 = 未知，与主库约定一致）
 * @param senseKey 义项键
 */
export function candidateKeyOf(
  normalizedLemma: string,
  pos: string,
  senseKey: string,
): string {
  return `${normalizedLemma}|${pos}|${senseKey}`;
}
