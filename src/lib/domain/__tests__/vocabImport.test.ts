import { describe, expect, it } from 'vitest';
import {
  buildImportPreview,
  canonicalPos,
  detectVocabImportFormat,
  extractJsonWords,
  mapHeaders,
  normalizeLemma,
  parseDelimited,
  vocabularyKey,
} from '../vocabImport';

describe('vocabImport 解析', () => {
  it('识别 CSV/TSV/JSON', () => {
    expect(detectVocabImportFormat('a.csv', 'lemma,pos')).toBe('CSV');
    expect(detectVocabImportFormat('a.tsv', 'lemma\tpos')).toBe('TSV');
    expect(detectVocabImportFormat('a.json', '[]')).toBe('JSON');
    expect(detectVocabImportFormat('noext', 'lemma\tpos\nbank\tn')).toBe('TSV');
  });

  it('支持引号、转义与字段内换行', () => {
    const rows = parseDelimited('word,definition\n"bank","a ""safe"" place"\n"line","x\ny"\n', ',');
    expect(rows).toEqual([
      ['word', 'definition'],
      ['bank', 'a "safe" place'],
      ['line', 'x\ny'],
    ]);
  });

  it('表头别名映射且不重复占用字段', () => {
    const mapping = mapHeaders(['单词', 'word', '词性', '释义']);
    expect(mapping['单词']).toBe('lemma');
    expect(mapping['word']).toBeNull();
    expect(mapping['词性']).toBe('pos');
    expect(mapping['释义']).toBe('definitionZh');
  });

  it('归一化 lemma / pos', () => {
    expect(normalizeLemma('  “Bank” ')).toBe('bank');
    expect(normalizeLemma('ICE   cream')).toBe('ice cream');
    expect(canonicalPos('Noun')).toBe('n');
    expect(canonicalPos('形容词')).toBe('形容词');
  });

  it('身份键包含义项，不把同形异义合并', () => {
    expect(vocabularyKey({ normalizedLemma: 'bank', pos: 'n', senseKey: 'default' })).toBe('en|bank|n|default');
    expect(vocabularyKey({ normalizedLemma: 'bank', pos: 'n', senseKey: 'river' })).toBe('en|bank|n|river');
  });
});

describe('vocabImport 预览', () => {
  it('区分 NEW / 文件内重复 / 已存在 / 冲突 / 无效', () => {
    const csv = [
      'lemma,pos,definitionZh',
      'bank,n,银行',
      'bank,n,银行',
      'river,n,河流',
      'run,v,跑',
      ',n,空词条',
    ].join('\n');
    const existing = new Map<string, string | null>([
      [vocabularyKey({ normalizedLemma: 'river', pos: 'n', senseKey: 'default' }), '河流'],
      [vocabularyKey({ normalizedLemma: 'run', pos: 'v', senseKey: 'default' }), '经营'],
    ]);
    const preview = buildImportPreview({ fileName: 'words.csv', text: csv, existing });
    expect(preview.counts.NEW).toBe(1);
    expect(preview.counts.DUPLICATE_IN_FILE).toBe(1);
    expect(preview.counts.EXISTS).toBe(1);
    expect(preview.counts.CONFLICT).toBe(1);
    expect(preview.counts.INVALID).toBe(1);
    expect(preview.blockingErrors).toEqual([]);
  });

  it('缺少词条列时阻断', () => {
    const preview = buildImportPreview({ fileName: 'x.csv', text: 'foo,bar\na,b' });
    expect(preview.blockingErrors.join()).toContain('未识别到词条列');
  });

  it('超过上限时阻断', () => {
    const lines = ['lemma,definitionZh', ...Array.from({ length: 5 }, (_, i) => `w${i},释义`)];
    const preview = buildImportPreview({ fileName: 'x.csv', text: lines.join('\n'), maxRows: 3 });
    expect(preview.blockingErrors.join()).toContain('超过单次导入上限');
  });

  it('解析 TypeWords 备份中的词条', () => {
    const json = JSON.stringify({
      version: 5,
      val: {
        dict: {
          val: {
            word: {
              bookList: [
                {
                  name: 'OS Deck',
                  words: [
                    {
                      word: 'resilient',
                      phonetic0: '/rɪˈzɪliənt/',
                      phonetic1: '',
                      trans: [{ pos: 'adj', cn: '有韧性的' }],
                      sentences: [{ c: 'She is resilient.', cn: '' }],
                      phrases: [],
                    },
                  ],
                  statistics: [],
                },
              ],
            },
          },
        },
      },
    });
    const extracted = extractJsonWords(json);
    expect(extracted.shape).toBe('typewords.backup');
    const preview = buildImportPreview({ fileName: 'backup.json', text: json });
    expect(preview.counts.NEW).toBe(1);
    expect(preview.rows[0].item?.pos).toBe('adj');
  });
});
