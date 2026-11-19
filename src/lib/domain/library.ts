/**
 * 方法论资料库的纯规则。
 *
 * 三条原则：
 * 1. 只存元数据、许可说明和个人摘要 —— 不复制原站正文；
 * 2. 阅读状态必须由「实际动作」支撑：写摘要、做实践、写计划，而不是点一下就算完成；
 * 3. 预设条目固定 16 条，seed 可重复执行（按 URL 幂等），校验在纯函数里完成。
 */

import {
  LIBRARY_SEED_SIZE,
  LIBRARY_SUMMARY_MIN_CHARS,
  METHODOLOGY_CATEGORIES,
  RESOURCE_DONE_REQUIRES_ACTION,
} from '../constants';
import type {
  MethodologyCategory,
  ResourcePriority,
  ResourceReadStatus,
  StageProfileCode,
} from '../types';

export interface MethodologySeedItem {
  title: string;
  creator: string;
  url: string;
  resourceType: string;
  priority: ResourcePriority;
  category: MethodologyCategory;
  stageFit: StageProfileCode[];
  licenseNote: string;
  summary: string;
  sortOrder: number;
}

export type LibraryGate = { ok: true } | { ok: false; error: string };

const SEED_RESOURCE_TYPES = ['REPO', 'ARTICLE', 'TEMPLATE', 'GUIDE'];
const SEED_PRIORITIES: ResourcePriority[] = ['P0', 'P1', 'P2'];
const SEED_STAGE_CODES: StageProfileCode[] = [
  'PREPARATION',
  'A0_A2',
  'A2_B1',
  'B1_B2',
  'IELTS_INTENSIVE',
];

/** 校验 seed：恰好 16 条、URL 唯一且为 https、分类/优先级/类型/阶段均合法、说明非空。 */
export function validateMethodologySeed(
  items: readonly MethodologySeedItem[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (items.length !== LIBRARY_SEED_SIZE) {
    errors.push(`预设条目应为 ${LIBRARY_SEED_SIZE} 条，实际 ${items.length} 条`);
  }

  const seen = new Set<string>();
  items.forEach((item, index) => {
    const label = `第 ${index + 1} 条「${item.title || '（无标题）'}」`;
    if (!item.title?.trim()) errors.push(`${label} 缺少标题`);
    if (!item.url?.startsWith('https://')) errors.push(`${label} 链接必须为 https`);
    if (seen.has(item.url)) errors.push(`${label} 链接重复：${item.url}`);
    seen.add(item.url);
    if (!SEED_RESOURCE_TYPES.includes(item.resourceType)) {
      errors.push(`${label} 资源类型不合法：${item.resourceType}`);
    }
    if (!SEED_PRIORITIES.includes(item.priority)) errors.push(`${label} 优先级不合法：${item.priority}`);
    if (!METHODOLOGY_CATEGORIES.includes(item.category)) {
      errors.push(`${label} 分类不合法：${item.category}`);
    }
    if (!Array.isArray(item.stageFit) || item.stageFit.length === 0) {
      errors.push(`${label} 缺少阶段适配`);
    } else {
      for (const code of item.stageFit) {
        if (!SEED_STAGE_CODES.includes(code)) errors.push(`${label} 阶段不合法：${code}`);
      }
    }
    if (!item.licenseNote?.trim()) errors.push(`${label} 缺少许可说明`);
    if (!item.summary?.trim()) errors.push(`${label} 缺少个人摘要`);
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 阅读日志草稿（Action 校验前先经过这里）。 */
export interface ReadingLogDraft {
  status: ResourceReadStatus;
  personalSummary: string | null;
  plannedAction: string | null;
  appliedEvidenceId: string | null;
}

/** 状态推进 gate：摘要 → 实践 → 完成，每一步都要有对应内容。 */
export function checkReadingLog(draft: ReadingLogDraft): LibraryGate {
  const summary = (draft.personalSummary ?? '').trim();
  const action = (draft.plannedAction ?? '').trim();

  if (draft.status === 'NOT_STARTED') return { ok: true };

  if (draft.status === 'SUMMARIZED' && summary.length < LIBRARY_SUMMARY_MIN_CHARS) {
    return {
      ok: false,
      error: `标记「已写摘要」前，请先写下至少 ${LIBRARY_SUMMARY_MIN_CHARS} 字的个人摘要（不复制原文）`,
    };
  }

  if (draft.status === 'APPLIED') {
    if (summary.length < LIBRARY_SUMMARY_MIN_CHARS) {
      return {
        ok: false,
        error: `标记「已实践」前，请先写下至少 ${LIBRARY_SUMMARY_MIN_CHARS} 字的个人摘要`,
      };
    }
    if (!action) {
      return { ok: false, error: '标记「已实践」前，请写清你实际做了什么练习' };
    }
  }

  if (draft.status === 'DONE' && RESOURCE_DONE_REQUIRES_ACTION) {
    if (!action) {
      return { ok: false, error: '标记「已完成」前，请填写实践计划或实际完成情况' };
    }
  }

  return { ok: true };
}

/** 首次进入阅读态或之后的任何更新都记录业务日；未开始则清空。 */
export function readingLastReadAt(status: ResourceReadStatus, todayStr: string): string | null {
  return status === 'NOT_STARTED' ? null : todayStr;
}

export interface LibraryRowLite {
  priority: ResourcePriority;
  readingStatus: ResourceReadStatus | null;
}

export interface LibraryProgress {
  total: number;
  started: number;
  summarized: number;
  applied: number;
  done: number;
  byPriority: Record<ResourcePriority, { total: number; started: number; done: number }>;
}

const STARTED: ResourceReadStatus[] = ['READING', 'SUMMARIZED', 'APPLIED', 'DONE'];
const SUMMARIZED: ResourceReadStatus[] = ['SUMMARIZED', 'APPLIED', 'DONE'];
const APPLIED: ResourceReadStatus[] = ['APPLIED', 'DONE'];

/** 统计（纯函数，页面不自己算）。 */
export function libraryProgress(rows: readonly LibraryRowLite[]): LibraryProgress {
  const byPriority: LibraryProgress['byPriority'] = {
    P0: { total: 0, started: 0, done: 0 },
    P1: { total: 0, started: 0, done: 0 },
    P2: { total: 0, started: 0, done: 0 },
  };
  let started = 0;
  let summarized = 0;
  let applied = 0;
  let done = 0;

  for (const row of rows) {
    const status = row.readingStatus;
    byPriority[row.priority].total += 1;
    if (status && STARTED.includes(status)) {
      started += 1;
      byPriority[row.priority].started += 1;
    }
    if (status && SUMMARIZED.includes(status)) summarized += 1;
    if (status && APPLIED.includes(status)) applied += 1;
    if (status === 'DONE') {
      done += 1;
      byPriority[row.priority].done += 1;
    }
  }

  return { total: rows.length, started, summarized, applied, done, byPriority };
}
