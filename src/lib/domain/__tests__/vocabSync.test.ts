import { describe, expect, it } from 'vitest';
import {
  buildTypeWordsBackup,
  effectiveSeconds,
  overlapSeconds,
  parseTypeWordsBackup,
  sessionInterval,
} from '../vocabSync';

function backupJson(statistics: unknown[], words: unknown[] = []): string {
  return JSON.stringify({
    version: 5,
    val: {
      dict: {
        version: 4,
        val: {
          word: {
            bookList: [
              {
                name: 'OS Deck',
                words,
                statistics,
              },
            ],
          },
        },
      },
      setting: { version: 23, val: {} },
    },
  });
}

describe('TypeWords 备份解析', () => {
  it('按 segments 生成会话与稳定 id', () => {
    const text = backupJson([
      {
        startDate: Date.parse('2026-11-19T01:00:00Z'),
        spend: 120000,
        total: 20,
        new: 5,
        review: 15,
        wrong: 2,
        segments: [
          [Date.parse('2026-11-19T01:00:00Z'), Date.parse('2026-11-19T01:01:00Z')],
          [Date.parse('2026-11-19T01:02:00Z'), Date.parse('2026-11-19T01:03:00Z')],
        ],
        sessionRole: 'single',
      },
    ]);
    const parsed = parseTypeWordsBackup(text);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].durationSeconds).toBe(120);
    expect(parsed.sessions[0].wrong).toBe(2);
    expect(parsed.sessions[0].canonicalKey).toContain('typewords:');

    const again = parseTypeWordsBackup(text);
    expect(again.sessions[0].canonicalKey).toBe(parsed.sessions[0].canonicalKey);
  });

  it('无 segments 时用 spend 兜底', () => {
    const text = backupJson([
      { startDate: 1_700_000_000_000, spend: 90_000, total: 9, new: 0, review: 9, wrong: 1 },
    ]);
    const parsed = parseTypeWordsBackup(text);
    expect(parsed.sessions[0].durationSeconds).toBe(90);
    expect(parsed.warnings).toEqual([]);
  });

  it('缺少字典时给出警告，不抛错', () => {
    const text = JSON.stringify({ version: 5, val: { dict: { version: 4, val: { word: { bookList: [] } } } } });
    const parsed = parseTypeWordsBackup(text);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.warnings.join()).toContain('没有单词词典');
  });

  it('非 TypeWords 备份直接报错', () => {
    expect(() => parseTypeWordsBackup('{"version":1}')).toThrow('缺少 val.dict.val');
  });
});

describe('重叠时长', () => {
  it('与既有区间重叠的部分不重复计时', () => {
    const interval = { startMs: 0, endMs: 60_000 };
    expect(overlapSeconds(interval, [{ startMs: 30_000, endMs: 90_000 }])).toBe(30);
    expect(effectiveSeconds(interval, [{ startMs: 30_000, endMs: 90_000 }])).toBe(30);
    expect(effectiveSeconds(interval, [])).toBe(60);
  });

  it('多个区间重叠只算一次', () => {
    const interval = { startMs: 0, endMs: 60_000 };
    expect(
      overlapSeconds(interval, [
        { startMs: 0, endMs: 20_000 },
        { startMs: 10_000, endMs: 30_000 },
      ]),
    ).toBe(30);
  });

  it('会话区间取自 segments 的外包络', () => {
    const text = backupJson([
      {
        startDate: 1000,
        spend: 3000,
        total: 1,
        new: 1,
        review: 0,
        wrong: 0,
        segments: [
          [1000, 2000],
          [2500, 4000],
        ],
      },
    ]);
    const parsed = parseTypeWordsBackup(text);
    const interval = sessionInterval(parsed.sessions[0]);
    expect(interval.startMs).toBe(1000);
    expect(interval.endMs).toBe(4000);
  });
});

describe('导出兼容包', () => {
  it('生成 TypeWords 备份结构', () => {
    const pkg = buildTypeWordsBackup({
      deckId: 'deck-1',
      title: 'OS Deck',
      words: [
        {
          lemma: 'resilient',
          normalizedLemma: 'resilient',
          pos: 'adj',
          senseKey: 'default',
          definitionZh: '有韧性的',
          definitionEn: null,
          phoneticUk: '/rɪˈzɪliənt/',
          phoneticUs: null,
          examples: ['She is resilient.'],
          collocations: [],
          tags: [],
          sourceRef: null,
        },
      ],
    }) as {
      version: number;
      val: { dict: { version: number; val: { word: { bookList: Array<{ words: unknown[] }> } } } };
    };
    expect(pkg.version).toBe(5);
    expect(pkg.val.dict.version).toBe(4);
    expect(pkg.val.dict.val.word.bookList[0].words).toHaveLength(1);
  });
});

describe('内置词典导出裁剪', () => {
  it('声明了词条数但 words 为空时提示只导入统计', () => {
    const text = JSON.stringify({
      version: 5,
      val: {
        dict: {
          version: 4,
          val: {
            word: {
              bookList: [{ name: 'CET-4', length: 2607, words: [], statistics: [] }],
            },
          },
        },
      },
    });
    const parsed = parseTypeWordsBackup(text);
    expect(parsed.words).toEqual([]);
    expect(parsed.warnings.join()).toContain('只导入会话统计');
  });
});
