/**
 * 领域导出（T33）：补齐 grammar / mistakes / vocab / sentences / reviews 五类。
 *
 * 与「整库导出」的分工：
 * - `api/export/json` / `api/export/csv?table=` 是**技术备份**（21 张表的原始快照）；
 * - 这里的是**可读报表**（每个领域一份，列名是中文业务字段，能直接看）。
 */

import {
  EGIU_COLOR_LABEL_ZH,
  EGIU_COLORS,
  ERROR_CATEGORY_LABEL_ZH,
  IELTS_ERROR_CATEGORY_LABEL_ZH,
  INTERVAL_LABEL_ZH,
  MASTERY_LABEL_ZH,
  REVIEW_STATUS_LABEL_ZH,
  SENTENCE_COMPONENT_LABEL_ZH,
  TARGET_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { toBusinessDate } from '@/lib/date';
import { prisma } from '@/lib/prisma';
import { parseTokens } from '@/lib/queries/sentences';
import type {
  DomainExportKind,
  EgiuColor,
  ErrorCategory,
  IeltsErrorCategory,
  IntervalCode,
  MasteryLevel,
  ReviewStatus,
  SentenceComponent,
  TargetType,
} from '@/lib/types';

/** 一份可读报表。 */
export interface DomainExport {
  kind: DomainExportKind;
  title: string;
  fileName: string;
  headers: string[];
  rows: (string | number | null)[][];
}

/** 单元格转字符串（null → 空串）。 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** RFC 4180 转义。 */
function escapeCsv(value: string | number | null | undefined): string {
  const text = cell(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 报表 → CSV 文本（带 BOM，Excel 打开不乱码）。 */
export function toDomainCsv(report: DomainExport): string {
  const lines: string[] = [];
  lines.push(report.headers.map(escapeCsv).join(','));
  for (const row of report.rows) {
    lines.push(row.map(escapeCsv).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** EGIU（语法诊断）报表。 */
async function buildGrammarReport(timeZone: string): Promise<DomainExport> {
  const rows = await prisma.egiuLesson.findMany({
    orderBy: [{ learnedDate: 'desc' }, { unitNo: 'asc' }],
    include: { reviews: { orderBy: [{ reviewDate: 'asc' }] } },
  });

  return {
    kind: 'grammar',
    title: '语法诊断（EGIU）',
    fileName: 'grammar_egiu',
    headers: [
      '教材',
      '单元',
      '知识点',
      '当前三色',
      '综合分S',
      '判定理由',
      '首测日D0',
      '连续绿灯',
      '是否掌握',
      '掌握时间',
      '低频池',
      '下次复习',
      '复测次数',
      '复测明细',
      '已归档',
    ],
    rows: rows.map((row) => [
      row.book,
      row.unitNo,
      row.knowledgePoint,
      EGIU_COLOR_LABEL_ZH[row.currentColor as EgiuColor] ?? row.currentColor,
      row.currentScore,
      row.currentReason,
      row.learnedDate,
      row.greenStreak,
      row.masteredAt ? '是' : '否',
      row.masteredAt ? toBusinessDate(row.masteredAt, timeZone) : null,
      row.inLowFreqPool ? '是' : '否',
      row.nextReviewDate,
      row.retestCount,
      row.reviews
        .map(
          (review) =>
            `${review.reviewDate}:${review.judgedColor}(${review.correctQuestions}/${review.totalQuestions})`,
        )
        .join(' | '),
      row.archivedAt ? '是' : '否',
    ]),
  };
}

/** 错题本报表。 */
async function buildMistakesReport(): Promise<DomainExport> {
  const rows = await prisma.mistake.findMany({ orderBy: [{ createdAt: 'desc' }] });

  return {
    kind: 'mistakes',
    title: '错题本',
    fileName: 'mistakes',
    headers: [
      '原题',
      '我的答案',
      '正确答案',
      '错误原因',
      '知识点',
      '错误类别',
      '雅思错因',
      '错误类别取值中(EGIU)',
      '复习次数',
      '上次复习',
      '下次复习',
      '已掌握',
      '创建时间',
      '已归档',
    ],
    rows: rows.map((row) => [
      row.originalQuestion,
      row.myAnswer,
      row.correctAnswer,
      row.errorReason,
      row.knowledgePoint,
      ERROR_CATEGORY_LABEL_ZH[row.errorCategory as ErrorCategory] ?? row.errorCategory,
      row.ieltsErrorCategory
        ? (IELTS_ERROR_CATEGORY_LABEL_ZH[row.ieltsErrorCategory as IeltsErrorCategory] ??
          row.ieltsErrorCategory)
        : null,
      row.errorCategory,
      row.reviewCount,
      row.lastReviewAt,
      row.nextReviewAt,
      row.isMastered ? '是' : '否',
      row.createdAt.toISOString(),
      row.archivedAt ? '是' : '否',
    ]),
  };
}

/** 词汇报表（三档并列，不合并）。 */
async function buildVocabReport(): Promise<DomainExport> {
  const rows = await prisma.vocabWord.findMany({ orderBy: [{ learnedDate: 'desc' }] });

  return {
    kind: 'vocab',
    title: '词汇',
    fileName: 'vocab',
    headers: [
      '单词',
      '音标',
      '词性',
      '中文释义',
      '英文释义',
      '搭配',
      '例句',
      '来源',
      '学习日',
      '掌握度',
      '上次复习',
      '下次复习',
      '是否新词',
      '已归档',
    ],
    rows: rows.map((row) => [
      row.word,
      row.phonetic,
      row.partOfSpeech,
      row.meaningZh,
      row.meaningEn,
      row.collocation,
      row.exampleSentence,
      row.source,
      row.learnedDate,
      MASTERY_LABEL_ZH[row.mastery as MasteryLevel] ?? row.mastery,
      row.lastReviewAt,
      row.nextReviewAt,
      row.isNew ? '是' : '否',
      row.archivedAt ? '是' : '否',
    ]),
  };
}

/** 句子成分报表。 */
async function buildSentencesReport(): Promise<DomainExport> {
  const rows = await prisma.sentenceAnalysis.findMany({
    orderBy: [{ sentenceDate: 'desc' }, { createdAt: 'desc' }],
  });

  return {
    kind: 'sentences',
    title: '句子成分分析',
    fileName: 'sentences',
    headers: ['英文句子', '中文释义', '成分标注', '词性标注', '是否标对', '错误原因', '句型标签', '句子日期'],
    rows: rows.map((row) => {
      const tokens = parseTokens(row.tokens);
      return [
        row.sentenceEn,
        row.sentenceZh,
        tokens
          .map((token) => (token.component ? `${token.text}/${SENTENCE_COMPONENT_LABEL_ZH[token.component as SentenceComponent] ?? token.component}` : token.text))
          .join(' '),
        tokens.map((token) => (token.pos ? `${token.text}/${token.pos}` : token.text)).join(' '),
        row.isCorrect ? '是' : '否',
        row.errorReason,
        row.patternTag,
        row.sentenceDate,
      ];
    }),
  };
}

/** 复习队列报表。 */
async function buildReviewsReport(): Promise<DomainExport> {
  const rows = await prisma.reviewTask.findMany({
    orderBy: [{ dueDate: 'asc' }],
    take: 5000,
  });

  return {
    kind: 'reviews',
    title: '复习队列',
    fileName: 'reviews',
    headers: [
      '目标类型',
      '目标',
      '知识点',
      '间隔档',
      '到期日',
      '状态',
      '预估分钟',
      '结果',
      '完成时间',
      '跳过原因',
      '创建时间',
    ],
    rows: rows.map((row) => [
      TARGET_TYPE_LABEL_ZH[row.targetType as TargetType] ?? row.targetType,
      row.targetLabel,
      row.knowledgePoint,
      INTERVAL_LABEL_ZH[row.intervalCode as IntervalCode] ?? row.intervalCode,
      row.dueDate,
      REVIEW_STATUS_LABEL_ZH[row.status as ReviewStatus] ?? row.status,
      row.estMinutes,
      row.result,
      row.completedAt ? row.completedAt.toISOString() : null,
      row.skippedReason,
      row.createdAt.toISOString(),
    ]),
  };
}

/** 三色取值的展示顺序（供页面图例复用）。 */
export const EGIU_EXPORT_COLOR_ORDER: EgiuColor[] = EGIU_COLORS;

/** 构建指定领域的报表。 */
export async function buildDomainExport(kind: DomainExportKind, timeZone: string): Promise<DomainExport> {
  switch (kind) {
    case 'grammar':
      return buildGrammarReport(timeZone);
    case 'mistakes':
      return buildMistakesReport();
    case 'vocab':
      return buildVocabReport();
    case 'sentences':
      return buildSentencesReport();
    case 'reviews':
      return buildReviewsReport();
    default:
      return buildReviewsReport();
  }
}

/** 校验领域导出类别。 */
export function isDomainExportKind(value: string): value is DomainExportKind {
  return (
    value === 'grammar' ||
    value === 'mistakes' ||
    value === 'vocab' ||
    value === 'sentences' ||
    value === 'reviews'
  );
}
