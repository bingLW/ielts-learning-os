/**
 * 材料域只读查询（T08 先落地 7 个，其余 8 个由 T10–T13 在本文件追加）。
 *
 * 硬约束：本文件只做「读 + 组装 DTO」，不写库、不做权限裁决（裁决在 action 层）。
 * DTO 必须可序列化（全部是 string/number/boolean/数组/普通对象），
 * 因为页面把 rows 直接传给 Client Component。
 */

import {
  MATERIAL_CONSISTENCY_STATUSES,
  MATERIAL_EXERCISE_REVIEW_STATUSES,
  MATERIAL_EXERCISE_REVIEW_STATUS_LABELS_ZH,
  MATERIAL_EXERCISE_SKILLS,
  MATERIAL_EXERCISE_TYPE_LABELS_ZH,
  MATERIAL_EXERCISE_TYPES,
  MATERIAL_EXTRACTION_KINDS,
  MATERIAL_EXTRACTION_KIND_LABELS_ZH,
  MATERIAL_FORMAT_LABELS_ZH,
  MATERIAL_LIMITS,
  MATERIAL_P0_FORMATS,
  MATERIAL_RESTRICTED_SOURCE_TYPES,
  MATERIAL_SOURCE_TYPE_LABELS_ZH,
  MATERIAL_SOURCE_TYPES,
  MATERIAL_STATUS_LABELS_ZH,
  MATERIAL_JOB_STAGE_LABELS_ZH,
  MATERIAL_JOB_STAGES,
  MATERIAL_REVIEW_STATUSES,
  MATERIAL_REVIEW_STATUS_LABELS_ZH,
  MATERIAL_SUSPICION_FLAGS,
  MATERIAL_SYNC_STATUSES,
  MATERIAL_SYNC_STATUS_LABELS_ZH,
  type MaterialAttemptEvidenceType,
  type MaterialConsistencyStatus,
  type MaterialExerciseReviewStatus,
  type MaterialExerciseSkill,
  type MaterialExerciseType,
  type MaterialExtractionKind,
  type MaterialFormat,
  type MaterialJobStage,
  type MaterialReviewStatus,
  type MaterialSourceType,
  type MaterialStatus,
  type MaterialSuspicionFlag,
  type MaterialSyncStatus,
} from '@/lib/constants';
import {
  EXERCISE_ANCHOR_KINDS,
  EXERCISE_ANCHOR_REVIEW_STATUSES,
} from '@/lib/materials/exerciseCheck';
import {
  candidateKeyOf,
  isNormalizationDrift,
  normalizeMaterialLemma,
} from '@/lib/domain/lemmaNormalize';
import { canonicalPos } from '@/lib/domain/vocabImport';
import { validateProposalAgainstBudget } from '@/lib/domain/taskProposal';
import { addDays, listDateRange } from '@/lib/date';
import { parseJson, parseStringArray } from '@/lib/json';
import { prisma } from '@/lib/prisma';
import { getEffectiveBudget } from './budget';
import {
  isCancellable,
  isProcessingStatus,
  isRetryable,
} from '@/lib/materials/stateMachine';
import { MATERIAL_UPLOAD_LIMITS, type MaterialUploadLimitsDto } from '@/lib/materials/upload';
import { MATERIAL_ALLOWED_EXTENSIONS } from '@/lib/storage';

// ───────────────────────────── DTO ─────────────────────────────

/** 材料库列表行。 */
export interface MaterialCardDto {
  id: string;
  title: string;
  format: MaterialFormat;
  formatLabel: string;
  status: MaterialStatus;
  statusLabel: string;
  statusReason: string | null;
  sourceType: MaterialSourceType;
  sourceTypeLabel: string;
  /** `unknown` / `licensed_subscription`：导出与原文下载受限（A-05）。 */
  restrictedSource: boolean;
  charCount: number;
  wordCount: number;
  pageCount: number | null;
  chunkCount: number;
  estimatedMinutes: number | null;
  originFileName: string | null;
  duplicateOfId: string | null;
  createdAt: string;
}

/** 材料详情页头部。 */
export interface MaterialHeaderDto {
  id: string;
  title: string;
  format: MaterialFormat;
  formatLabel: string;
  status: MaterialStatus;
  statusLabel: string;
  statusReason: string | null;
  sourceType: MaterialSourceType;
  sourceTypeLabel: string;
  restrictedSource: boolean;
  language: string;
  charCount: number;
  wordCount: number;
  pageCount: number | null;
  chunkCount: number;
  estimatedMinutes: number | null;
  originFileName: string | null;
  createdAt: string;
}

/** 处理时间线的单个阶段。 */
export interface ProcessingStageDto {
  stage: MaterialJobStage;
  label: string;
  status: 'done' | 'active' | 'pending' | 'failed';
  /** 该阶段耗时（毫秒）；未执行为 null。 */
  ms: number | null;
}

/** 处理状态（`/api/materials/[id]/tick` 的响应体，架构 §3.1）。 */
/** 材料级**累计** AI 用量（跨运行相加，Q5 成本可见性）。 */
export interface MaterialAiUsageDto {
  /** 累计 AI 调用次数（= 各次运行 `ProcessingJob.aiCallCount` 之和）。 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface MaterialStatusDto {
  materialId: string;
  title: string;
  format: MaterialFormat;
  formatLabel: string;
  status: MaterialStatus;
  statusLabel: string;
  statusReason: string | null;
  stage: MaterialJobStage | null;
  stageLabel: string | null;
  progress: {
    done: number;
    total: number;
    unitLabel: string;
    /**
     * 本阶段额外跳过的单元数（T12 §7.1）。
     *
     * `generating` 的续跑判据是"这些 chunk 已经出过题了"，所以第二个 tick 上
     * `done === total` 但一道新题都没生成。只说「批次 4 / 4」会让用户以为生成了
     * 4 批题的答案，结果是 0 —— 必须把"其中几批是被跳过的"说出来。
     */
    skipped: number;
  };
  stages: ProcessingStageDto[];
  error?: { code: string; message: string };
  cancellable: boolean;
  retryable: boolean;
  /** 累计用量：界面必须展示，否则「单次运行上限」对用户是隐形的。 */
  aiUsage: MaterialAiUsageDto;
  /** UI 是否应继续轮询（处理中才轮询）。 */
  polling: boolean;
  partial?: {
    pages: number[];
    droppedElements: Record<string, number>;
    aiCallLimitHit: boolean;
  };
}

/** 导入失败行（同 `contentHash` 合并展示）。 */
export interface FailedMaterialDto {
  contentHash: string;
  title: string;
  format: MaterialFormat;
  formatLabel: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** 失败了几次（同 hash 的材料条数）。 */
  occurrences: number;
  /** 最近一次的任务尝试次数。 */
  attempt: number;
  lastFailedAt: string;
  materialIds: string[];
}

/** 删除预览（G-01/G-02：先告诉用户会删什么、留什么）。 */
export interface DeletionPreviewDto {
  materialId: string;
  title: string;
  /** 会被删除的行数（17 张派生表合计，不含 AICallLog 账本）。 */
  deleteRows: number;
  /** 已同步进主库的词条数（保留）。 */
  keepVocabulary: number;
  /** 已确认成任务的草案条目数（PlanTask 保留）。 */
  keepPlanTasks: number;
  /** 已写入证据的作答数（EvidenceRecord 保留）。 */
  keepAttempts: number;
  /** 原文文件大小（字节），用于提示「同时删除本地文件」。 */
  fileSizeBytes: number | null;
}

/** 导入向导上下文（限额 + 来源文案 + 能力矩阵）。 */
export interface ImportContextDto {
  limits: MaterialUploadLimitsDto;
  /** `accept` 属性值，直接给 `<input type="file">`。 */
  accept: string;
  supportedFormats: Array<{
    format: MaterialFormat;
    label: string;
    /** P0 可直接解析；P1 只登记。 */
    priority: 'P0' | 'P1';
    /** P1 的能力边界说明（P0 为 null）。 */
    limitation: string | null;
  }>;
  sourceTypes: Array<{
    value: MaterialSourceType;
    label: string;
    requiresLicenseName: boolean;
    requiresUrl: boolean;
    restricted: boolean;
  }>;
  /** 已有材料条数（向导第 1 步提示「命中同内容会先问你」）。 */
  existingMaterialCount: number;
  unknownSourceWarning: string;
  rightsNotice: string;
}

// ───────────────────────────── helpers ─────────────────────────────

function formatOf(value: string): MaterialFormat {
  return value as MaterialFormat;
}

function formatLabelOf(value: string): string {
  return MATERIAL_FORMAT_LABELS_ZH[value as MaterialFormat] ?? value;
}

function statusLabelOf(value: string): string {
  return MATERIAL_STATUS_LABELS_ZH[value as MaterialStatus] ?? value;
}

function sourceLabelOf(value: string): string {
  return MATERIAL_SOURCE_TYPE_LABELS_ZH[value as MaterialSourceType] ?? value;
}

function isRestrictedSource(value: string): boolean {
  return (MATERIAL_RESTRICTED_SOURCE_TYPES as readonly string[]).includes(value);
}

/** 处理中的状态集合（含 `created`，因为首个 tick 就要跑校验）。 */
function isPolling(status: MaterialStatus): boolean {
  return isProcessingStatus(status);
}

// ───────────────────────────── 查询 ─────────────────────────────

export interface MaterialListFilter {
  format?: MaterialFormat;
  status?: MaterialStatus;
  sourceType?: MaterialSourceType;
  /** 标题模糊匹配（大小写不敏感，SQLite 默认 `LIKE` 对 ASCII 不敏感）。 */
  q?: string;
}

/** 材料库列表（按创建时间倒序）。 */
export async function listMaterials(filter: MaterialListFilter = {}): Promise<MaterialCardDto[]> {
  const rows = await prisma.learningMaterial.findMany({
    where: {
      ...(filter.format ? { format: filter.format } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.sourceType ? { sourceType: filter.sourceType } : {}),
      ...(filter.q && filter.q.trim() ? { title: { contains: filter.q.trim() } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    format: formatOf(row.format),
    formatLabel: formatLabelOf(row.format),
    status: row.status as MaterialStatus,
    statusLabel: statusLabelOf(row.status),
    statusReason: row.statusReason,
    sourceType: row.sourceType as MaterialSourceType,
    sourceTypeLabel: sourceLabelOf(row.sourceType),
    restrictedSource: isRestrictedSource(row.sourceType),
    charCount: row.charCount,
    wordCount: row.wordCount,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    estimatedMinutes: row.estimatedMinutes,
    originFileName: row.originFileName,
    duplicateOfId: row.duplicateOfId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 材料详情页头部（不存在返回 null）。 */
export async function getMaterialHeader(id: string): Promise<MaterialHeaderDto | null> {
  const row = await prisma.learningMaterial.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      format: true,
      status: true,
      statusReason: true,
      sourceType: true,
      language: true,
      charCount: true,
      wordCount: true,
      pageCount: true,
      chunkCount: true,
      estimatedMinutes: true,
      originFileName: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    format: formatOf(row.format),
    formatLabel: formatLabelOf(row.format),
    status: row.status as MaterialStatus,
    statusLabel: statusLabelOf(row.status),
    statusReason: row.statusReason,
    sourceType: row.sourceType as MaterialSourceType,
    sourceTypeLabel: sourceLabelOf(row.sourceType),
    restrictedSource: isRestrictedSource(row.sourceType),
    language: row.language,
    charCount: row.charCount,
    wordCount: row.wordCount,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    estimatedMinutes: row.estimatedMinutes,
    originFileName: row.originFileName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 处理状态（tick 响应体；材料不存在返回 null）。 */
export async function getMaterialStatus(id: string): Promise<MaterialStatusDto | null> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      format: true,
      status: true,
      statusReason: true,
      chunkCount: true,
      aiCallCount: true,
      inputTokens: true,
      outputTokens: true,
      estimatedCostUsd: true,
    },
  });
  if (!material) return null;

  const job = await prisma.processingJob.findFirst({
    where: { materialId: id },
    orderBy: { startedAt: 'desc' },
    select: {
      stage: true,
      status: true,
      errorCode: true,
      errorMessage: true,
      progressJson: true,
      startedAt: true,
      lastTickAt: true,
    },
  });

  const document = await prisma.parsedDocument.findFirst({
    where: { materialId: id, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { warningsJson: true },
  });

  const status = material.status as MaterialStatus;
  const stage = (job?.stage as MaterialJobStage | undefined) ?? null;

  // `progressJson` 的实际结构见 pipeline.ts 的 JobProgress（比 DTO 多 msByStage）
  const progressRaw = parseJson<Record<string, unknown>>(job?.progressJson, {}) ?? {};
  const rawMs = progressRaw.msByStage;
  const msByStage: Record<string, number> =
    rawMs && typeof rawMs === 'object' ? (rawMs as Record<string, number>) : {};

  const stages: ProcessingStageDto[] = MATERIAL_JOB_STAGES.map((item) => {
    const ms = typeof msByStage[item] === 'number' ? msByStage[item] : null;
    let stageStatus: ProcessingStageDto['status'] = 'pending';
    if (item === stage) {
      stageStatus = job?.status === 'failed' ? 'failed' : job?.status === 'succeeded' ? 'done' : 'active';
    } else if (ms !== null) {
      stageStatus = 'done';
    }
    return {
      stage: item,
      label: MATERIAL_JOB_STAGE_LABELS_ZH[item],
      status: stageStatus,
      ms,
    };
  });

  const warnings = parseJson<Record<string, unknown>>(document?.warningsJson, {}) ?? {};
  const rawDropped = warnings.droppedElements;
  const droppedElements: Record<string, number> =
    rawDropped && typeof rawDropped === 'object' ? (rawDropped as Record<string, number>) : {};
  const rawPages = warnings.noTextLayerPages;
  const noTextLayerPages: number[] = Array.isArray(rawPages)
    ? rawPages.filter((item): item is number => typeof item === 'number')
    : [];

  const dto: MaterialStatusDto = {
    materialId: material.id,
    title: material.title,
    format: formatOf(material.format),
    formatLabel: formatLabelOf(material.format),
    status,
    statusLabel: statusLabelOf(status),
    statusReason: material.statusReason,
    stage,
    stageLabel: stage ? MATERIAL_JOB_STAGE_LABELS_ZH[stage] : null,
    progress: {
      done: typeof progressRaw.done === 'number' ? progressRaw.done : 0,
      total: typeof progressRaw.total === 'number' ? (progressRaw.total as number) : 1,
      unitLabel:
        typeof progressRaw.unitLabel === 'string' && progressRaw.unitLabel
          ? progressRaw.unitLabel
          : '项',
      skipped:
        typeof progressRaw.skipped === 'number'
        && Number.isFinite(progressRaw.skipped)
        && progressRaw.skipped > 0
          ? (progressRaw.skipped as number)
          : 0,
    },
    stages,
    // 材料级累计用量：job 计数器每次运行归零，这里才是"这份材料总共花了多少"
    aiUsage: {
      calls: material.aiCallCount,
      inputTokens: material.inputTokens,
      outputTokens: material.outputTokens,
      estimatedCostUsd: material.estimatedCostUsd,
    },
    cancellable: isCancellable(status) && job?.status === 'running',
    retryable: isRetryable(status),
    polling: isPolling(status),
  };

  if (status === 'failed' && (job?.errorCode || job?.errorMessage)) {
    dto.error = {
      code: job?.errorCode ?? 'INVALID_MAGIC',
      message: job?.errorMessage ?? '处理失败，可重试',
    };
  }

  if (status === 'partial') {
    dto.partial = {
      pages: noTextLayerPages,
      droppedElements,
      aiCallLimitHit: false,
    };
  }

  return dto;
}

/** 处理时间线（阶段 + 状态 + 耗时）。 */
export async function getProcessingTimeline(id: string): Promise<ProcessingStageDto[]> {
  const status = await getMaterialStatus(id);
  return status?.stages ?? [];
}

/**
 * 导入失败列表：同一 `contentHash` 合并成一行。
 *
 * 为什么合并：用户重试同一份文件会留下多条 failed 记录，逐条列出等于刷屏；
 * 合并后仍保留 `materialIds` 便于逐个删除。
 */
export async function listFailedMaterials(): Promise<FailedMaterialDto[]> {
  const rows = await prisma.learningMaterial.findMany({
    where: { status: 'failed' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      format: true,
      contentHash: true,
      updatedAt: true,
      jobs: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { errorCode: true, errorMessage: true, attempt: true },
      },
    },
  });

  const grouped = new Map<string, FailedMaterialDto>();
  for (const row of rows) {
    const job = row.jobs[0];
    const existing = grouped.get(row.contentHash);
    const failedAt = row.updatedAt.toISOString();
    if (existing) {
      existing.occurrences += 1;
      existing.materialIds.push(row.id);
      existing.attempt = Math.max(existing.attempt, job?.attempt ?? 1);
      if (failedAt > existing.lastFailedAt) existing.lastFailedAt = failedAt;
      continue;
    }
    grouped.set(row.contentHash, {
      contentHash: row.contentHash,
      title: row.title,
      format: formatOf(row.format),
      formatLabel: formatLabelOf(row.format),
      errorCode: job?.errorCode ?? null,
      errorMessage: job?.errorMessage ?? null,
      occurrences: 1,
      attempt: job?.attempt ?? 1,
      lastFailedAt: failedAt,
      materialIds: [row.id],
    });
  }

  return [...grouped.values()].sort((a, b) => (a.lastFailedAt < b.lastFailedAt ? 1 : -1));
}

/**
 * 删除预览：告诉用户「会删多少行、会留下什么」。
 *
 * `keepPlanTasks` / `keepAttempts` 的口径（G-01/G-02）：
 * - 词条：已同步进主库的候选（`syncStatus='synced'`）—— 词条本体在 `VocabularyItem`，不受级联影响；
 * - 任务：已确认草案条目（`TaskProposal.status='confirmed'`）—— 已写入的 `PlanTask` 独立存在；
 * - 作答：已写入证据的作答（`evidenceId != null`）—— `EvidenceRecord` 独立存在。
 */
export async function getDeletionPreview(id: string): Promise<DeletionPreviewDto> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      format: true,
      assets: { where: { kind: 'ORIGINAL_FILE' }, select: { sizeBytes: true }, take: 1 },
    },
  });
  if (!material) {
    return {
      materialId: id,
      title: '（材料已不存在）',
      deleteRows: 0,
      keepVocabulary: 0,
      keepPlanTasks: 0,
      keepAttempts: 0,
      fileSizeBytes: null,
    };
  }

  const [
    sources,
    permissions,
    assets,
    jobs,
    documents,
    chunks,
    extractions,
    vocabulary,
    sentences,
    sets,
    exercises,
    attempts,
    packs,
    packItems,
    proposals,
    proposalItems,
    keepVocabulary,
    keepPlanTasks,
    keepAttempts,
  ] = await Promise.all([
    prisma.materialSource.count({ where: { materialId: id } }),
    prisma.materialPermissionRecord.count({ where: { materialId: id } }),
    prisma.materialAsset.count({ where: { materialId: id } }),
    prisma.processingJob.count({ where: { materialId: id } }),
    prisma.parsedDocument.count({ where: { materialId: id } }),
    prisma.contentChunk.count({ where: { materialId: id } }),
    prisma.extractionResult.count({ where: { materialId: id } }),
    prisma.vocabularyCandidate.count({ where: { materialId: id } }),
    prisma.sentenceCandidate.count({ where: { materialId: id } }),
    prisma.materialExerciseSet.count({ where: { materialId: id } }),
    prisma.generatedExercise.count({ where: { materialId: id } }),
    prisma.exerciseAttempt.count({ where: { materialId: id } }),
    prisma.materialPack.count({ where: { materialId: id } }),
    prisma.materialPackItem.count({ where: { pack: { materialId: id } } }),
    prisma.taskProposal.count({ where: { materialId: id } }),
    prisma.taskProposalItem.count({ where: { proposal: { materialId: id } } }),
    prisma.vocabularyCandidate.count({ where: { materialId: id, syncStatus: 'synced' } }),
    prisma.taskProposalItem.count({
      where: { proposal: { materialId: id, status: 'confirmed' } },
    }),
    prisma.exerciseAttempt.count({ where: { materialId: id, evidenceId: { not: null } } }),
  ]);

  const deleteRows =
    sources +
    permissions +
    assets +
    jobs +
    documents +
    chunks +
    extractions +
    vocabulary +
    sentences +
    sets +
    exercises +
    attempts +
    packs +
    packItems +
    proposals +
    proposalItems +
    1; // 材料主行本身

  return {
    materialId: material.id,
    title: material.title,
    deleteRows,
    keepVocabulary,
    keepPlanTasks,
    keepAttempts,
    fileSizeBytes: material.assets[0]?.sizeBytes ?? null,
  };
}

/** 导入向导上下文（限额、来源文案、能力矩阵）。 */
export async function getMaterialImportContext(): Promise<ImportContextDto> {
  const existingMaterialCount = await prisma.learningMaterial.count();

  const supportedFormats: ImportContextDto['supportedFormats'] = (
    ['TXT', 'MARKDOWN', 'HTML', 'PDF', 'DOCX', 'PASTED_TEXT', 'AUDIO', 'VIDEO'] as MaterialFormat[]
  ).map((format) => {
    const p0 = (MATERIAL_P0_FORMATS as readonly string[]).includes(format);
    return {
      format,
      label: MATERIAL_FORMAT_LABELS_ZH[format],
      priority: p0 ? 'P0' : 'P1',
      limitation: p0
        ? null
        : format === 'AUDIO' || format === 'VIDEO'
          ? '本期只登记资产，不转写、不分析（P1）'
          : null,
    };
  });

  return {
    limits: MATERIAL_UPLOAD_LIMITS,
    accept: MATERIAL_ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(','),
    supportedFormats,
    sourceTypes: MATERIAL_SOURCE_TYPES.map((value) => ({
      value,
      label: MATERIAL_SOURCE_TYPE_LABELS_ZH[value],
      requiresLicenseName: value === 'open_license',
      requiresUrl: value === 'user_provided_url',
      restricted: isRestrictedSource(value),
    })),
    existingMaterialCount,
    unknownSourceWarning:
      '「来源不确定」的材料会常驻警示，且禁止导出与原文下载 —— 请尽量补充来源信息。',
    rightsNotice:
      '你必须确认对这份材料有使用权限。系统不会代你判断版权，导入不等于获得授权。',
  };
}

/** 便于页面展示的「限额摘要」文案（避免前端硬编码数字）。 */
export function describeLimits(limits: MaterialUploadLimitsDto = MATERIAL_UPLOAD_LIMITS): string[] {
  return [
    `单文件 ≤ ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB`,
    `PDF ≤ ${limits.maxPdfPages} 页`,
    `单材料 ≤ ${limits.maxChunks} 个分块`,
    `粘贴摘录 ≤ ${limits.maxPastedChars} 字符`,
    `单材料 AI 调用 ≤ ${limits.maxAiCalls} 次`,
    `单次解析超时 ${Math.round(MATERIAL_LIMITS.parseTimeoutMs / 1000)} 秒`,
  ];
}

/** 供 UI 复用的标签工具（避免多处各写一份映射）。 */
export const MATERIAL_LABEL_HELPERS = {
  formatLabel: formatLabelOf,
  statusLabel: statusLabelOf,
  sourceLabel: sourceLabelOf,
  isRestrictedSource,
} as const;

// ═════════════════════ T10：Reader（原文 / 词汇辅助）+ AI 分析审核 ═════════════════════

/** Reader 的两种模式。`original` **永不**出现任何 AI 文本（C-11）。 */
export const MATERIAL_READER_MODES = ['original', 'vocab_assist'] as const;
export type MaterialReaderMode = (typeof MATERIAL_READER_MODES)[number];

/**
 * 原文区里的词汇提示（位置是 **chunk 内局部偏移**，不是文档偏移）。
 *
 * T12 起多了两件事（U-2）：
 * - `candidateId`：这个词在词汇候选表里对应的那一行（没有物化过就是 null）。
 *   有它才能从原文一键跳到「审这个词」，否则用户只能自己去候选列表里翻。
 * - `definitionSource`：释义到底是**主库**的还是 **AI** 的。
 *   这是必须区分的：主库释义是人确认过的，不该再挂「AI 辅助」的警示；
 *   而 AI 释义必须标注（C-04 / ADR-04 的展示要求）。
 */
export interface VocabHintDto {
  extractionId: string;
  candidateId: string | null;
  lemma: string;
  pos: string | null;
  definitionZh: string | null;
  /** `library` = 主库已有释义（优先）；`ai` = AI 给出的候选释义。 */
  definitionSource: 'library' | 'ai';
  start: number;
  end: number;
  source: 'ai';
}

export interface ReaderChunkDto {
  id: string;
  seq: number;
  kind: string;
  headingPath: string | null;
  page: number | null;
  paragraphIndex: number | null;
  charStart: number;
  charEnd: number;
  text: string;
  suspicionFlags: MaterialSuspicionFlag[];
  hints: VocabHintDto[];
}

export interface ReaderViewDto {
  materialId: string;
  title: string;
  mode: MaterialReaderMode;
  docVersion: number;
  pageCount: number | null;
  chunks: ReaderChunkDto[];
  /** 有 chunk 命中疑似注入话术时才非 null（只提示，不影响内容）。 */
  injectionNotice: { affectedChunks: number; flags: MaterialSuspicionFlag[] } | null;
}

export interface TocItemDto {
  chunkId: string;
  seq: number;
  headingPath: string;
  page: number | null;
}

export interface ExtractionCardDto {
  id: string;
  kind: MaterialExtractionKind;
  chunkId: string | null;
  page: number | null;
  paragraphIndex: number | null;
  sourceQuote: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  reviewStatus: MaterialReviewStatus;
  sourceVerified: boolean;
  isDerived: true;
  createdAt: string;
}

export interface MaterialSourceDto {
  sourceType: MaterialSourceType;
  url: string | null;
  author: string | null;
  publisher: string | null;
  publishedYear: number | null;
  licenseName: string | null;
  licenseUrl: string | null;
  userNote: string | null;
  rightsConfirmed: boolean;
  rightsConfirmedAt: string | null;
  restrictedExport: boolean;
}

/** `suspicionFlags` 列（逗号分隔）→ 已知标记数组；未知值直接丢弃。 */
function parseSuspicionFlags(raw: string | null): MaterialSuspicionFlag[] {
  if (!raw) return [];
  const known = new Set<string>(MATERIAL_SUSPICION_FLAGS);
  const seen = new Set<MaterialSuspicionFlag>();
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length === 0 || !known.has(trimmed)) continue;
    seen.add(trimmed as MaterialSuspicionFlag);
  }
  return MATERIAL_SUSPICION_FLAGS.filter((flag) => seen.has(flag));
}

/**
 * 计算一条 KEYWORD 结果在 chunk 内的字符区间。
 *
 * 为什么不直接用 `ExtractionResult.charStart`：那是**文档级**偏移，而 Reader 是按
 * chunk 渲染的，需要 chunk 内局部偏移。也没有逐词的 token 级偏移可用，所以只能
 * 「先定位 sourceQuote（回验已经保证它逐字来自本块），再在区间里找 lemma」。
 * **找不到就返回 null 丢弃该 hint** —— 宁可不显示，也不能把高亮画到错的地方。
 */
function locateHint(
  text: string,
  sourceQuote: string,
  lemma: string,
): { start: number; end: number } | null {
  if (lemma.length === 0) return null;
  const lower = text.toLowerCase();

  const quoteAt = sourceQuote.length > 0 ? text.indexOf(sourceQuote) : -1;
  const regionStart = quoteAt >= 0 ? quoteAt : 0;
  const regionEnd = quoteAt >= 0 ? quoteAt + sourceQuote.length : text.length;

  const at = lower.indexOf(lemma.toLowerCase(), regionStart);
  if (at < 0 || at + lemma.length > regionEnd) return null;

  const start = Math.max(0, Math.min(at, text.length));
  const end = Math.max(start, Math.min(at + lemma.length, text.length));
  return end > start ? { start, end } : null;
}

/**
 * Reader 视图（原文 / 词汇辅助）。
 *
 * **硬规则（AC-03 / C-11）**：`mode === 'original'` 在查 `ExtractionResult` 之前就 return，
 * `hints` 恒为 `[]`。这不是"查了不渲染"，而是原文模式**根本不读** AI 表 ——
 * 这样即便将来 UI 出错，原文区也不可能冒出 AI 文本。
 *
 * @param id 材料 id
 * @param mode 阅读模式（默认原文）
 */
export async function getReaderView(
  id: string,
  mode: MaterialReaderMode = 'original',
): Promise<ReaderViewDto | null> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: { id: true, title: true, language: true },
  });
  if (!material) return null;

  const document = await prisma.parsedDocument.findFirst({
    where: { materialId: id, isCurrent: true },
    select: { id: true, version: true, pageCount: true },
  });
  if (!document) return null;

  const chunkRows = await prisma.contentChunk.findMany({
    where: { parsedDocumentId: document.id },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      kind: true,
      headingPath: true,
      page: true,
      paragraphIndex: true,
      charStart: true,
      charEnd: true,
      text: true,
      suspicionFlags: true,
    },
  });

  // ── 注入提示（两种模式都有：这是安全提示，不是 AI 分析结果） ──────────
  const flagSet = new Set<MaterialSuspicionFlag>();
  let affectedChunks = 0;
  for (const row of chunkRows) {
    const flags = parseSuspicionFlags(row.suspicionFlags);
    if (flags.length === 0) continue;
    affectedChunks += 1;
    for (const flag of flags) flagSet.add(flag);
  }
  const injectionNotice =
    affectedChunks > 0
      ? {
          affectedChunks,
          flags: MATERIAL_SUSPICION_FLAGS.filter((flag) => flagSet.has(flag)),
        }
      : null;

  const baseChunks: ReaderChunkDto[] = chunkRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    headingPath: row.headingPath,
    page: row.page,
    paragraphIndex: row.paragraphIndex,
    charStart: row.charStart,
    charEnd: row.charEnd,
    text: row.text,
    suspicionFlags: parseSuspicionFlags(row.suspicionFlags),
    hints: [],
  }));

  // ── 原文模式：到此为止，**绝不**触碰 ExtractionResult / VocabularyCandidate ──
  if (mode !== 'vocab_assist') {
    return {
      materialId: material.id,
      title: material.title,
      mode: 'original',
      docVersion: document.version,
      pageCount: document.pageCount,
      chunks: baseChunks,
      injectionNotice,
    };
  }

  // ── 词汇辅助模式：只取**已裁决**的 KEYWORD（draft 不得进 Reader） ──────
  const keywordRows = await prisma.extractionResult.findMany({
    where: {
      materialId: id,
      kind: 'KEYWORD',
      reviewStatus: { in: ['accepted', 'edited'] },
      chunkId: { not: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      chunkId: true,
      payloadJson: true,
      editedPayloadJson: true,
      sourceQuote: true,
    },
  });

  const chunkById = new Map(baseChunks.map((chunk) => [chunk.id, chunk]));
  const hintsByChunk = new Map<string, VocabHintDto[]>();

  for (const row of keywordRows) {
    if (!row.chunkId) continue;
    const chunk = chunkById.get(row.chunkId);
    if (!chunk) continue;

    // 用户改过的以 `editedPayloadJson` 为准；AI 原始输出永不覆盖
    const payload =
      parseJson<Record<string, unknown>>(row.editedPayloadJson ?? row.payloadJson, {}) ?? {};
    const lemma = typeof payload.lemma === 'string' ? payload.lemma.trim() : '';
    if (lemma.length === 0) continue;

    const located = locateHint(chunk.text, row.sourceQuote, lemma);
    if (!located) continue;

    const hint: VocabHintDto = {
      extractionId: row.id,
      // 下面两步（候选 / 主库）统一在循环外批量补齐，避免 N+1
      candidateId: null,
      lemma,
      pos: typeof payload.pos === 'string' && payload.pos.trim().length > 0 ? payload.pos : null,
      definitionZh:
        typeof payload.definition_zh === 'string' && payload.definition_zh.trim().length > 0
          ? payload.definition_zh
          : null,
      definitionSource: 'ai',
      start: located.start,
      end: located.end,
      source: 'ai',
    };

    const list = hintsByChunk.get(chunk.id) ?? [];
    list.push(hint);
    hintsByChunk.set(chunk.id, list);
  }

  // ── 词汇候选（`candidateId`）+ 主库释义（U-2：主库优先） ────────────────
  //
  // 两次批量查，而不是在循环里逐条查：一份 200 段的材料会有几百个 hint，
  // 逐条查候选与主库就是几百次往返（页面直接卡成"未响应"）。
  if (hintsByChunk.size > 0) {
    const [candidateRows, libraryRows] = await Promise.all([
      prisma.vocabularyCandidate.findMany({
        where: { materialId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, chunkId: true, normalizedLemma: true, pos: true },
      }),
      // 只查 hint 里出现过的词条：`normalizedLemma` 有索引，这个 IN 很便宜
      (async () => {
        const lemmas = new Set<string>();
        for (const list of hintsByChunk.values()) {
          for (const hint of list) {
            const normalized = normalizeMaterialLemma(hint.lemma);
            if (normalized.length > 0) lemmas.add(normalized);
          }
        }
        if (lemmas.size === 0) return [];
        return prisma.vocabularyItem.findMany({
          where: {
            language: material.language || 'en',
            archivedAt: null,
            normalizedLemma: { in: Array.from(lemmas) },
          },
          select: { id: true, normalizedLemma: true, pos: true, definitionZh: true },
        });
      })(),
    ]);

    // 候选按 `chunkId + 归一化词条 + 词性` 对齐（同一段里同一个词只会有一条候选）
    const candidateByKey = new Map<string, { id: string }>();
    for (const row of candidateRows) {
      const key = `${row.chunkId}|${row.normalizedLemma}|${row.pos}`;
      if (!candidateByKey.has(key)) candidateByKey.set(key, { id: row.id });
    }

    // 主库释义：先按「同词 + 同词性」，再退回「同词 + 词性未知」的行
    const libraryExact = new Map<string, string>();
    const libraryAnyPos = new Map<string, string>();
    for (const item of libraryRows) {
      const definition = (item.definitionZh ?? '').trim();
      if (definition.length === 0) continue;
      if (!libraryExact.has(`${item.normalizedLemma}|${item.pos}`)) {
        libraryExact.set(`${item.normalizedLemma}|${item.pos}`, definition);
      }
      if (!libraryAnyPos.has(item.normalizedLemma)) {
        libraryAnyPos.set(item.normalizedLemma, definition);
      }
    }

    for (const [chunkId, list] of hintsByChunk) {
      for (const hint of list) {
        const normalized = normalizeMaterialLemma(hint.lemma);
        const pos = canonicalPos(hint.pos);
        hint.candidateId = candidateByKey.get(`${chunkId}|${normalized}|${pos}`)?.id ?? null;

        // 主库释义优先（U-2）：主库是人工确认过的，AI 释义只是候选
        const libraryDefinition =
          libraryExact.get(`${normalized}|${pos}`) ?? libraryAnyPos.get(normalized) ?? null;
        if (libraryDefinition !== null) {
          hint.definitionZh = libraryDefinition;
          hint.definitionSource = 'library';
        }
      }
    }
  }

  for (const [chunkId, list] of hintsByChunk) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    // 按起点排序，渲染层再按"跳过重叠"切片（重叠的后一条直接丢弃）
    chunk.hints = list.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  return {
    materialId: material.id,
    title: material.title,
    mode: 'vocab_assist',
    docVersion: document.version,
    pageCount: document.pageCount,
    chunks: baseChunks,
    injectionNotice,
  };
}

/** Reader 目录：只列有标题路径的 chunk（按 seq 升序）。 */
export async function listChunkToc(id: string): Promise<TocItemDto[]> {
  const document = await prisma.parsedDocument.findFirst({
    where: { materialId: id, isCurrent: true },
    select: { id: true },
  });
  if (!document) return [];

  const rows = await prisma.contentChunk.findMany({
    where: { parsedDocumentId: document.id, headingPath: { not: null } },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, headingPath: true, page: true },
  });

  return rows
    .filter((row) => (row.headingPath ?? '').trim().length > 0)
    .map((row) => ({
      chunkId: row.id,
      seq: row.seq,
      headingPath: (row.headingPath ?? '').trim(),
      page: row.page,
    }));
}

/**
 * AI 分析结果列表（审核页用）。
 *
 * `payloadJson` 解析失败退化为 `{}` 而不是抛错：一条脏数据不该让整页 500。
 *
 * @param id 材料 id
 * @param kind 可选种别过滤
 */
export async function listExtractionResults(
  id: string,
  kind?: MaterialExtractionKind,
): Promise<ExtractionCardDto[]> {
  const rows = await prisma.extractionResult.findMany({
    where: { materialId: id, ...(kind ? { kind } : {}) },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      kind: true,
      chunkId: true,
      page: true,
      paragraphIndex: true,
      sourceQuote: true,
      payloadJson: true,
      editedPayloadJson: true,
      reviewStatus: true,
      sourceVerified: true,
      createdAt: true,
    },
  });

  return rows.map((row) => {
    const edited = row.editedPayloadJson
      ? parseJson<Record<string, unknown> | null>(row.editedPayloadJson, null)
      : null;
    return {
      id: row.id,
      kind: (MATERIAL_EXTRACTION_KINDS as readonly string[]).includes(row.kind)
        ? (row.kind as MaterialExtractionKind)
        : 'KEYWORD',
      chunkId: row.chunkId,
      page: row.page,
      paragraphIndex: row.paragraphIndex,
      sourceQuote: row.sourceQuote,
      payload: parseJson<Record<string, unknown>>(row.payloadJson, {}) ?? {},
      editedPayload:
        edited && typeof edited === 'object' && !Array.isArray(edited) ? edited : null,
      reviewStatus: (MATERIAL_REVIEW_STATUSES as readonly string[]).includes(row.reviewStatus)
        ? (row.reviewStatus as MaterialReviewStatus)
        : 'draft',
      sourceVerified: row.sourceVerified,
      isDerived: true,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** 来源登记（Reader 页脚 / 分析页头部展示；不存在返回 null）。 */
export async function getMaterialSource(id: string): Promise<MaterialSourceDto | null> {
  const row = await prisma.materialSource.findUnique({
    where: { materialId: id },
    select: {
      sourceType: true,
      url: true,
      author: true,
      publisher: true,
      publishedYear: true,
      licenseName: true,
      licenseUrl: true,
      userNote: true,
      rightsConfirmed: true,
      rightsConfirmedAt: true,
    },
  });
  if (!row) return null;

  return {
    sourceType: row.sourceType as MaterialSourceType,
    url: row.url,
    author: row.author,
    publisher: row.publisher,
    publishedYear: row.publishedYear,
    licenseName: row.licenseName,
    licenseUrl: row.licenseUrl,
    userNote: row.userNote,
    rightsConfirmed: row.rightsConfirmed,
    rightsConfirmedAt: row.rightsConfirmedAt ? row.rightsConfirmedAt.toISOString() : null,
    // 受限来源禁止导出（R1/R2）：DTO 直接给出结论，页面不再自己判断
    restrictedExport: isRestrictedSource(row.sourceType),
  };
}

/** chunk 级分析覆盖率（「继续分析剩余 N 块」与续跑前置都用它）。 */
export interface MaterialAnalysisProgressDto {
  totalChunks: number;
  /** 已有 `ExtractionResult` 的 chunk 数（**被拒绝的也算**，不重跑）。 */
  analyzedChunks: number;
  remainingChunks: number;
}

/**
 * 统计「已分析 / 未分析」的 chunk 数。
 *
 * 口径与 `analyzing` 阶段完全一致：按 `ExtractionResult.chunkId` 去重，
 * `chunkId` 为 null 的行（SUMMARY）不计入。
 *
 * @param id 材料 id
 */
export async function getMaterialAnalysisProgress(
  id: string,
): Promise<MaterialAnalysisProgressDto> {
  const document = await prisma.parsedDocument.findFirst({
    where: { materialId: id, isCurrent: true },
    select: { id: true },
  });
  if (!document) return { totalChunks: 0, analyzedChunks: 0, remainingChunks: 0 };

  const [totalChunks, analyzedRows] = await Promise.all([
    prisma.contentChunk.count({ where: { parsedDocumentId: document.id } }),
    prisma.extractionResult.findMany({
      where: { materialId: id, chunkId: { not: null } },
      distinct: ['chunkId'],
      select: { chunkId: true },
    }),
  ]);

  const analyzedChunks = analyzedRows.filter((row) => row.chunkId !== null).length;
  return {
    totalChunks,
    analyzedChunks,
    remainingChunks: Math.max(0, totalChunks - analyzedChunks),
  };
}

// ═════════════════════ T11：练习生成 / 审核 / 作答 ═════════════════════

/** 练习集的题目分布（每种审核状态各多少道；`total` 不含已退役）。 */
export interface ExerciseSetCountsDto {
  total: number;
  draft: number;
  needsReview: number;
  approved: number;
  rejected: number;
  retired: number;
}

/** 练习集卡片（`/materials/[id]/exercises` 列表用）。 */
export interface ExerciseSetCardDto {
  id: string;
  materialId: string;
  materialTitle: string;
  title: string;
  targetSkill: MaterialExerciseSkill;
  targetSkillLabel: string;
  difficultyLevel: string | null;
  estimatedMinutes: number;
  /** 只含 `approved` 题时才为 true（UI 据此区分「仅练习」/「可作正式练习」）。 */
  hasApprovedOnly: boolean;
  isActive: boolean;
  counts: ExerciseSetCountsDto;
  createdAt: string;
}

/** 单个选项（`answerJson.options` 解析后的安全形态）。 */
export interface ExerciseOptionDto {
  key: string;
  text: string;
}

/** 一道题（作答前 `correctKey` / `explanation` 为 null，答案不提前泄露）。 */
export interface ExerciseDto {
  id: string;
  setId: string;
  type: MaterialExerciseType;
  typeLabel: string;
  targetSkill: MaterialExerciseSkill;
  subskill: string | null;
  difficultyEstimate: string | null;
  prompt: string;
  options: ExerciseOptionDto[];
  /** 只有 `revealAnswers` 为 true 时才给值。 */
  correctKey: string | null;
  explanation: string | null;
  evidenceQuote: string;
  consistencyCheck: MaterialConsistencyStatus;
  consistencyNote: string | null;
  reviewStatus: MaterialExerciseReviewStatus;
  reviewStatusLabel: string;
  chunkId: string;
  page: number | null;
  paragraphIndex: number | null;
  dedupeKey: string;
  retiredAt: string | null;
  retireReason: string | null;
  attemptCount: number;
  /** 最近一次作答是否正确（没作答过为 null）。 */
  lastAttemptCorrect: boolean | null;
}

/** 一条作答记录。 */
export interface ExerciseAttemptDto {
  id: string;
  exerciseId: string;
  selectedKey: string | null;
  isCorrect: boolean | null;
  reviewStatusAtAttempt: string;
  evidenceType: MaterialAttemptEvidenceType | string;
  createdAt: string;
}

/** 练习集详情（集合 + 题目 + 最近作答）。 */
export interface ExerciseSetDetailDto {
  set: ExerciseSetCardDto;
  materialStatus: MaterialStatus;
  exercises: ExerciseDto[];
  attempts: ExerciseAttemptDto[];
}

/** 「能不能生成练习」的只读结论（页面直接渲染，不再自己数）。 */
export interface MaterialExerciseReadinessDto {
  /** 已采纳/已修改采纳、且种别可出题的分析结果条数。 */
  acceptedAnchors: number;
  /** 还没裁决的分析结果条数（提示"先去审核"）。 */
  pendingExtractions: number;
  /** 现有未退役题目数（对比单材料上限）。 */
  exerciseCount: number;
  approvedCount: number;
  maxExercises: number;
  canGenerate: boolean;
  reasonZh: string | null;
}

/** 把 `answerJson` 解析成安全选项数组（脏数据退化为空数组，不让整页 500）。 */
function parseExerciseOptions(answerJson: string): {
  options: ExerciseOptionDto[];
  correctKey: string | null;
} {
  const parsed = parseJson<{ options?: unknown; correctKey?: unknown }>(answerJson, {}) ?? {};
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  const options: ExerciseOptionDto[] = [];
  for (const item of rawOptions) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { key?: unknown; text?: unknown };
    if (typeof record.key !== 'string' || typeof record.text !== 'string') continue;
    options.push({ key: record.key, text: record.text });
  }
  const correctKey =
    typeof parsed.correctKey === 'string' && parsed.correctKey.length > 0
      ? parsed.correctKey
      : null;
  return { options, correctKey };
}

/** `orderingJson` → 可用的顺序数组（脏数据退化为空数组 = 按创建时间）。 */
function parseOrdering(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function exerciseTypeOf(value: string): MaterialExerciseType {
  return (MATERIAL_EXERCISE_TYPES as readonly string[]).includes(value)
    ? (value as MaterialExerciseType)
    : 'reading_detail';
}

function exerciseSkillOf(value: string): MaterialExerciseSkill {
  return (MATERIAL_EXERCISE_SKILLS as readonly string[]).includes(value)
    ? (value as MaterialExerciseSkill)
    : 'READING';
}

function exerciseReviewStatusOf(value: string): MaterialExerciseReviewStatus {
  return (MATERIAL_EXERCISE_REVIEW_STATUSES as readonly string[]).includes(value)
    ? (value as MaterialExerciseReviewStatus)
    : 'draft';
}

function consistencyOf(value: string): MaterialConsistencyStatus {
  return (MATERIAL_CONSISTENCY_STATUSES as readonly string[]).includes(value)
    ? (value as MaterialConsistencyStatus)
    : 'unchecked';
}

/**
 * 材料题技能的中文名。
 *
 * 为什么不复用 `SKILL_LABEL_ZH`：那是 **SkillId** 的映射（`VOCAB`），
 * 而材料题用的是 `MATERIAL_EXERCISE_SKILLS`（`VOCABULARY`）—— 两套枚举混用
 * 会出现「词汇」在一边有、另一边查不到的静默降级。
 */
const EXERCISE_SKILL_LABELS_ZH: Record<MaterialExerciseSkill, string> = {
  READING: '阅读',
  VOCABULARY: '词汇',
  GRAMMAR: '语法',
};

/** 材料练习页的资格结论（只读，不写库）。 */
export async function getMaterialExerciseReadiness(
  materialId: string,
): Promise<MaterialExerciseReadinessDto> {
  const [acceptedAnchors, pendingExtractions, exerciseCount, approvedCount] = await Promise.all([
    prisma.extractionResult.count({
      where: {
        materialId,
        kind: { in: [...EXERCISE_ANCHOR_KINDS] },
        reviewStatus: { in: [...EXERCISE_ANCHOR_REVIEW_STATUSES] },
        chunkId: { not: null },
      },
    }),
    prisma.extractionResult.count({ where: { materialId, reviewStatus: 'draft' } }),
    prisma.generatedExercise.count({ where: { materialId, retiredAt: null } }),
    prisma.generatedExercise.count({
      where: { materialId, reviewStatus: 'approved', retiredAt: null },
    }),
  ]);

  const canGenerate = acceptedAnchors > 0;
  return {
    acceptedAnchors,
    pendingExtractions,
    exerciseCount,
    approvedCount,
    maxExercises: MATERIAL_LIMITS.maxExercises,
    canGenerate,
    reasonZh: canGenerate
      ? null
      : pendingExtractions > 0
        ? `还有 ${pendingExtractions} 条分析结果没裁决：先在「AI 分析」页采纳（或修改后采纳）至少一条，才有出题依据`
        : '没有可出题的分析结果：请回到处理页确认分析是否已完成',
  };
}

/** 练习集列表（活动集排在最前，其余按创建时间倒序）。 */
export async function listExerciseSets(materialId: string): Promise<ExerciseSetCardDto[]> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { id: true, title: true },
  });
  if (!material) return [];

  const sets = await prisma.materialExerciseSet.findMany({
    where: { materialId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      title: true,
      targetSkill: true,
      difficultyLevel: true,
      estimatedMinutes: true,
      hasApprovedOnly: true,
      isActive: true,
      createdAt: true,
    },
  });
  if (sets.length === 0) return [];

  // 一条 groupBy 拿到所有集合的分布，避免 N+1
  const grouped = await prisma.generatedExercise.groupBy({
    by: ['setId', 'reviewStatus'],
    where: { setId: { in: sets.map((set) => set.id) } },
    _count: { _all: true },
  });

  const countsBySet = new Map<string, ExerciseSetCountsDto>();
  for (const set of sets) {
    countsBySet.set(set.id, {
      total: 0,
      draft: 0,
      needsReview: 0,
      approved: 0,
      rejected: 0,
      retired: 0,
    });
  }
  for (const row of grouped) {
    const bucket = countsBySet.get(row.setId);
    if (!bucket) continue;
    const count = row._count._all;
    const status = exerciseReviewStatusOf(row.reviewStatus);
    if (status === 'draft') bucket.draft += count;
    else if (status === 'needs_review') bucket.needsReview += count;
    else if (status === 'approved') bucket.approved += count;
    else if (status === 'rejected') bucket.rejected += count;
    else bucket.retired += count;
    if (status !== 'retired') bucket.total += count;
  }

  return sets.map((set) => ({
    id: set.id,
    materialId: material.id,
    materialTitle: material.title,
    title: set.title,
    targetSkill: exerciseSkillOf(set.targetSkill),
    targetSkillLabel: EXERCISE_SKILL_LABELS_ZH[exerciseSkillOf(set.targetSkill)],
    difficultyLevel: set.difficultyLevel,
    estimatedMinutes: set.estimatedMinutes,
    hasApprovedOnly: set.hasApprovedOnly,
    isActive: set.isActive,
    counts:
      countsBySet.get(set.id) ?? {
        total: 0,
        draft: 0,
        needsReview: 0,
        approved: 0,
        rejected: 0,
        retired: 0,
      },
    createdAt: set.createdAt.toISOString(),
  }));
}

/**
 * 练习集详情。
 *
 * `revealAnswers` 默认 **false**：作答页在提交前不能拿到 `correctKey` 与解析，
 * 否则「先看答案再作答」在客户端就能作弊（DTO 一旦带出去就收不回来）。
 * 审核/编辑页显式传 `true`。
 *
 * @param setId 练习集 id
 * @param options `revealAnswers`：是否返回答案与解析
 */
export async function getExerciseSet(
  setId: string,
  options: { revealAnswers?: boolean } = {},
): Promise<ExerciseSetDetailDto | null> {
  const revealAnswers = options.revealAnswers === true;

  const setRow = await prisma.materialExerciseSet.findUnique({
    where: { id: setId },
    select: {
      id: true,
      materialId: true,
      title: true,
      targetSkill: true,
      difficultyLevel: true,
      estimatedMinutes: true,
      hasApprovedOnly: true,
      isActive: true,
      orderingJson: true,
      createdAt: true,
      material: { select: { title: true, status: true } },
    },
  });
  if (!setRow) return null;

  const [exerciseRows, attemptRows, grouped] = await Promise.all([
    prisma.generatedExercise.findMany({
      where: { setId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        targetSkill: true,
        subskill: true,
        difficultyEstimate: true,
        prompt: true,
        answerJson: true,
        explanation: true,
        evidenceQuote: true,
        chunkId: true,
        page: true,
        paragraphIndex: true,
        reviewStatus: true,
        consistencyCheck: true,
        consistencyNote: true,
        dedupeKey: true,
        retiredAt: true,
        retireReason: true,
      },
    }),
    prisma.exerciseAttempt.findMany({
      where: { setId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        exerciseId: true,
        responseJson: true,
        isCorrect: true,
        reviewStatusAtAttempt: true,
        evidenceType: true,
        createdAt: true,
      },
    }),
    prisma.generatedExercise.groupBy({
      by: ['reviewStatus'],
      where: { setId },
      _count: { _all: true },
    }),
  ]);

  // 作答统计（每题次数 + 最近一次对错）：attemptRows 已按时间倒序
  const attemptStats = new Map<string, { count: number; lastCorrect: boolean | null }>();
  for (const attempt of attemptRows) {
    const stat = attemptStats.get(attempt.exerciseId);
    if (stat) {
      stat.count += 1;
      continue;
    }
    attemptStats.set(attempt.exerciseId, { count: 1, lastCorrect: attempt.isCorrect });
  }

  const ordering = parseOrdering(setRow.orderingJson);
  const orderIndex = new Map(ordering.map((id, index) => [id, index]));

  const exercises: ExerciseDto[] = exerciseRows
    .map((row) => {
      const { options, correctKey } = parseExerciseOptions(row.answerJson);
      const stat = attemptStats.get(row.id);
      const reviewStatus = exerciseReviewStatusOf(row.reviewStatus);
      return {
        id: row.id,
        setId,
        type: exerciseTypeOf(row.type),
        typeLabel: MATERIAL_EXERCISE_TYPE_LABELS_ZH[exerciseTypeOf(row.type)],
        targetSkill: exerciseSkillOf(row.targetSkill),
        subskill: row.subskill,
        difficultyEstimate: row.difficultyEstimate,
        prompt: row.prompt,
        options,
        correctKey: revealAnswers ? correctKey : null,
        explanation: revealAnswers ? row.explanation : null,
        evidenceQuote: row.evidenceQuote,
        consistencyCheck: consistencyOf(row.consistencyCheck),
        consistencyNote: row.consistencyNote,
        reviewStatus,
        reviewStatusLabel: MATERIAL_EXERCISE_REVIEW_STATUS_LABELS_ZH[reviewStatus],
        chunkId: row.chunkId,
        page: row.page,
        paragraphIndex: row.paragraphIndex,
        dedupeKey: row.dedupeKey,
        retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
        retireReason: row.retireReason,
        attemptCount: stat?.count ?? 0,
        lastAttemptCorrect: stat?.lastCorrect ?? null,
      };
    })
    // `orderingJson` 是生成时的推荐顺序；没有它的旧数据按创建时间
    .sort((left, right) => {
      const leftIndex = orderIndex.get(left.id);
      const rightIndex = orderIndex.get(right.id);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });

  const counts: ExerciseSetCountsDto = {
    total: 0,
    draft: 0,
    needsReview: 0,
    approved: 0,
    rejected: 0,
    retired: 0,
  };
  for (const row of grouped) {
    const count = row._count._all;
    const status = exerciseReviewStatusOf(row.reviewStatus);
    if (status === 'draft') counts.draft += count;
    else if (status === 'needs_review') counts.needsReview += count;
    else if (status === 'approved') counts.approved += count;
    else if (status === 'rejected') counts.rejected += count;
    else counts.retired += count;
    if (status !== 'retired') counts.total += count;
  }

  const targetSkill = exerciseSkillOf(setRow.targetSkill);

  return {
    set: {
      id: setRow.id,
      materialId: setRow.materialId,
      materialTitle: setRow.material.title,
      title: setRow.title,
      targetSkill,
      targetSkillLabel: EXERCISE_SKILL_LABELS_ZH[targetSkill],
      difficultyLevel: setRow.difficultyLevel,
      estimatedMinutes: setRow.estimatedMinutes,
      hasApprovedOnly: setRow.hasApprovedOnly,
      isActive: setRow.isActive,
      counts,
      createdAt: setRow.createdAt.toISOString(),
    },
    materialStatus: setRow.material.status as MaterialStatus,
    exercises,
    attempts: attemptRows.map((row) => {
      const response = parseJson<{ selectedKey?: unknown }>(row.responseJson, {}) ?? {};
      return {
        id: row.id,
        exerciseId: row.exerciseId,
        selectedKey: typeof response.selectedKey === 'string' ? response.selectedKey : null,
        isCorrect: row.isCorrect,
        reviewStatusAtAttempt: row.reviewStatusAtAttempt,
        evidenceType: row.evidenceType,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  };
}

// ═════════════════════ T12：词汇候选审核 + 主库同步 ═════════════════════

/**
 * 候选列表的筛选值。
 *
 * `all` 之外只允许 `MATERIAL_REVIEW_STATUSES` 里的值：同步状态不在这里筛，
 * 因为"同步失败"是一个需要在汇总条上单独突出的异常，混进主筛选会把两件事搅在一起。
 */
export const VOCAB_CANDIDATE_FILTERS = ['all', ...MATERIAL_REVIEW_STATUSES] as const;
export type VocabCandidateFilter = (typeof VOCAB_CANDIDATE_FILTERS)[number];

/** 一条词汇候选（页面直接渲染，全部字段可序列化）。 */
export interface VocabCandidateDto {
  id: string;
  chunkId: string;
  /** 段落序号（阅读顺序；用来给列表排序，缺块时为 null）。 */
  chunkSeq: number | null;
  page: number | null;
  paragraphIndex: number | null;
  /** 原文里的真实写法（保留大小写）。 */
  surfaceForm: string;
  lemma: string;
  normalizedLemma: string;
  pos: string;
  senseKey: string;
  definitionZh: string | null;
  definitionEn: string | null;
  collocations: string[];
  contextSentence: string;
  occurrenceCount: number;
  reviewStatus: MaterialReviewStatus;
  reviewStatusLabel: string;
  syncStatus: MaterialSyncStatus;
  syncStatusLabel: string;
  /** 同步失败的人话原因（≤200 字，不含绝对路径）；成功/待同步时为 null。 */
  syncError: string | null;
  /** 主库是否已有同键词条（**现查**，不比物化时的快照）。 */
  existsInLibrary: boolean;
  existingItemId: string | null;
  /** 主库现有释义（只读：同步时只加来源，绝不覆盖）。 */
  libraryDefinitionZh: string | null;
  /** 主库现有词条写法（可能就是这个词，也可能是它的词典形）。 */
  libraryLemma: string | null;
  createdAt: string;
}

/**
 * 词汇候选汇总。
 *
 * `pending` 明确指 **`syncStatus === 'pending'`**（与 `synced` / `failed` / `skipped`
 * 同属同步状态），"还没裁决"的条数叫 `draft` —— 两个概念不能混用一个词，
 * 否则用户看到"待处理 12 条"根本不知道是要他审、还是在等同步。
 */
export interface MaterialVocabSummaryDto {
  total: number;
  /** 待审核（`reviewStatus === 'draft'`）。 */
  draft: number;
  accepted: number;
  rejected: number;
  /** 待同步（`syncStatus === 'pending'`）。 */
  pending: number;
  synced: number;
  failed: number;
  skipped: number;
  /** 主库已有同键词条的条数（现查，不是快照）。 */
  existsInLibrary: number;
}

/** 主库同键词条的快照（`Map` 的键与 `candidateKeyOf` 同构）。 */
interface LibraryItemBrief {
  id: string;
  lemma: string;
  definitionZh: string | null;
}

/**
 * 批量查主库同键词条。
 *
 * 一次 `IN` 查回来再在内存里建 Map —— 逐条查会变成 N+1（候选表动辄上百行）。
 *
 * @param normalizedLemmas 候选里出现过的归一化词条
 * @param language 词条语言（必须与材料一致，否则键不是一个空间）
 */
async function loadLibraryBriefs(
  normalizedLemmas: readonly string[],
  language: string,
): Promise<Map<string, LibraryItemBrief>> {
  const out = new Map<string, LibraryItemBrief>();
  const lemmas = Array.from(new Set(normalizedLemmas.filter((value) => value.length > 0)));
  if (lemmas.length === 0) return out;

  const rows = await prisma.vocabularyItem.findMany({
    where: { language, archivedAt: null, normalizedLemma: { in: lemmas } },
    select: { id: true, lemma: true, normalizedLemma: true, pos: true, senseKey: true, definitionZh: true },
  });
  for (const row of rows) {
    out.set(candidateKeyOf(row.normalizedLemma, row.pos, row.senseKey), {
      id: row.id,
      lemma: row.lemma,
      definitionZh: row.definitionZh,
    });
  }
  return out;
}

/** 审核状态归一（脏值退回 `draft`，与 `materialReviewSettle` 的口径一致）。 */
function vocabReviewStatusOf(raw: string): MaterialReviewStatus {
  return (MATERIAL_REVIEW_STATUSES as readonly string[]).includes(raw)
    ? (raw as MaterialReviewStatus)
    : 'draft';
}

/** 同步状态归一（脏值退回 `pending`：未被确认过的状态按"还没同步"处理最安全）。 */
function vocabSyncStatusOf(raw: string): MaterialSyncStatus {
  return (MATERIAL_SYNC_STATUSES as readonly string[]).includes(raw)
    ? (raw as MaterialSyncStatus)
    : 'pending';
}

/**
 * 词汇候选列表（按阅读顺序：段落序号 → 创建时间）。
 *
 * 为什么按阅读顺序而不是"最新在前"：审核候选是**通读**行为，用户沿着文章往下看
 * 才不会漏词。最新在前只适合"我刚加了什么"的场景，而候选不是用户加的。
 *
 * @param id 材料 id
 * @param status 只看某个审核状态（缺省 `all`）
 */
export async function listVocabularyCandidates(
  id: string,
  status: VocabCandidateFilter = 'all',
): Promise<VocabCandidateDto[]> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: { id: true, language: true },
  });
  if (!material) return [];

  const rows = await prisma.vocabularyCandidate.findMany({
    where: { materialId: id, ...(status === 'all' ? {} : { reviewStatus: status }) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      chunkId: true,
      surfaceForm: true,
      lemma: true,
      normalizedLemma: true,
      pos: true,
      senseKey: true,
      definitionZh: true,
      definitionEn: true,
      collocationsJson: true,
      contextSentence: true,
      occurrenceCount: true,
      reviewStatus: true,
      syncStatus: true,
      syncError: true,
      existsInLibrary: true,
      existingItemId: true,
      page: true,
      paragraphIndex: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return [];

  const [chunks, library] = await Promise.all([
    prisma.contentChunk.findMany({
      where: { id: { in: Array.from(new Set(rows.map((row) => row.chunkId))) } },
      select: { id: true, seq: true },
    }),
    loadLibraryBriefs(
      rows.map((row) => row.normalizedLemma),
      material.language || 'en',
    ),
  ]);
  const seqByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.seq]));

  const dtos: VocabCandidateDto[] = rows.map((row) => {
    const reviewStatus = vocabReviewStatusOf(row.reviewStatus);
    const syncStatus = vocabSyncStatusOf(row.syncStatus);
    const libraryItem = library.get(candidateKeyOf(row.normalizedLemma, row.pos, row.senseKey));
    return {
      id: row.id,
      chunkId: row.chunkId,
      chunkSeq: seqByChunk.get(row.chunkId) ?? null,
      page: row.page,
      paragraphIndex: row.paragraphIndex,
      surfaceForm: row.surfaceForm,
      lemma: row.lemma,
      normalizedLemma: row.normalizedLemma,
      pos: row.pos,
      senseKey: row.senseKey,
      definitionZh: row.definitionZh,
      definitionEn: row.definitionEn,
      collocations: parseStringArray(row.collocationsJson),
      contextSentence: row.contextSentence,
      occurrenceCount: row.occurrenceCount,
      reviewStatus,
      reviewStatusLabel: MATERIAL_REVIEW_STATUS_LABELS_ZH[reviewStatus],
      syncStatus,
      syncStatusLabel: MATERIAL_SYNC_STATUS_LABELS_ZH[syncStatus],
      syncError: row.syncError,
      // 现查优先于快照：快照会过期（用户可能刚导入或刚归档了同名词条）
      existsInLibrary: libraryItem !== undefined || row.existsInLibrary,
      existingItemId: libraryItem?.id ?? row.existingItemId,
      libraryDefinitionZh: libraryItem?.definitionZh ?? null,
      libraryLemma: libraryItem?.lemma ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return dtos.sort((left, right) => {
    const leftSeq = left.chunkSeq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = right.chunkSeq ?? Number.MAX_SAFE_INTEGER;
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

/**
 * 词汇候选汇总（页面顶部条 + 闸门提示都用它）。
 *
 * `existsInLibrary` 用**现查**：如果把过期快照当准，用户会看到"已在词库"却同步
 * 建出了一条新词条（或者反过来），两种都很难解释。
 *
 * @param id 材料 id
 */
export async function getMaterialVocabSummary(id: string): Promise<MaterialVocabSummaryDto> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: { id: true, language: true },
  });
  const empty: MaterialVocabSummaryDto = {
    total: 0,
    draft: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    existsInLibrary: 0,
  };
  if (!material) return empty;

  const [reviewCounts, syncCounts, rows] = await Promise.all([
    prisma.vocabularyCandidate.groupBy({
      by: ['reviewStatus'],
      where: { materialId: id },
      _count: { _all: true },
    }),
    prisma.vocabularyCandidate.groupBy({
      by: ['syncStatus'],
      where: { materialId: id },
      _count: { _all: true },
    }),
    prisma.vocabularyCandidate.findMany({
      where: { materialId: id },
      select: { normalizedLemma: true, pos: true, senseKey: true },
    }),
  ]);

  const summary: MaterialVocabSummaryDto = { ...empty, total: rows.length };
  for (const bucket of reviewCounts) {
    const status = vocabReviewStatusOf(bucket.reviewStatus);
    if (status === 'draft') summary.draft += bucket._count._all;
    else if (status === 'accepted') summary.accepted += bucket._count._all;
    else if (status === 'edited') summary.accepted += bucket._count._all;
    else summary.rejected += bucket._count._all;
  }
  for (const bucket of syncCounts) {
    const status = vocabSyncStatusOf(bucket.syncStatus);
    summary[status] += bucket._count._all;
  }

  if (rows.length > 0) {
    const library = await loadLibraryBriefs(
      rows.map((row) => row.normalizedLemma),
      material.language || 'en',
    );
    summary.existsInLibrary = rows.filter((row) =>
      library.has(candidateKeyOf(row.normalizedLemma, row.pos, row.senseKey)),
    ).length;
  }

  return summary;
}

/**
 * 主库里「归一化键是旧版本」的词条条数（**只读，不修复**）。
 *
 * 为什么需要这个数：T12 给 `normalizeLemma` 加了四条折叠（NFD→NFC、零宽、全角、
 * 弯引号），而 v2.3 起落库的 `normalizedLemma` 是旧算法算的。这些词条的键停在旧
 * 空间里，按新键查不到 —— 同步会走「原词形兜底」而不会重复建词条，但**用户有权知道
 * 库里不是完全干净的**。默默兜住、什么都不说，等于把数据债藏起来。
 *
 * 为什么用全表扫描而不是 SQL 表达式：`normalizeLemma` 是 JS 实现（Unicode 规范化、
 * 全角折叠），SQLite 没有等价函数。这里只投影两列短字符串，词库量级（万级以内）
 * 是一次毫秒级读取；真到十万级应该做成离线任务写快照，而不是每次开页面都算。
 */
export async function countNormalizationDrift(): Promise<number> {
  const rows = await prisma.vocabularyItem.findMany({
    where: { archivedAt: null },
    select: { lemma: true, normalizedLemma: true },
  });
  let drift = 0;
  for (const row of rows) {
    if (isNormalizationDrift(row)) drift += 1;
  }
  return drift;
}

// ═══════════════════ T13：材料包（AC-06）与任务草案（F-02/F-03） ═══════════════════

/** 材料包条目（引用式聚合；被引用对象删掉时 `missing=true`）。 */
export interface PackItemDto {
  id: string;
  itemType: string;
  refId: string;
  sortOrder: number;
  estimatedMinutes: number | null;
  note: string | null;
  /** 展示标题（如「第 3 段」「READING 练习：主旨」）。 */
  label: string;
  /** 次要说明（题量、候选数等）；没有则为 null。 */
  secondary: string | null;
  /** true = 被引用对象已不存在，页面显示「内容已移除」。 */
  missing: boolean;
  /** 可跳转的路径（没有对应页面时为 null）。 */
  href: string | null;
}

/** 材料包总览。 */
export interface MaterialPackDto {
  materialId: string;
  packId: string | null;
  learningGoals: string[];
  targetSkills: string[];
  difficultyEstimate: string | null;
  estimatedMinutes: number;
  /** 摘要（**引用** ExtractionResult，不复制正文）。 */
  summary: { extractionId: string; summaryZh: string } | null;
  items: PackItemDto[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** 草案条目（`finalXxx` 为用户改写值，缺省时用 `suggestedXxx`）。 */
export interface ProposalItemDto {
  id: string;
  module: string;
  targetSkill: string;
  title: string;
  suggestedMinutes: number;
  finalMinutes: number | null;
  suggestedDate: string;
  finalDate: string | null;
  granularity: number;
  reason: string | null;
  exerciseIds: string[];
  selected: boolean;
  planTaskId: string | null;
  /** 生效日期 = `finalDate ?? suggestedDate`（页面与校验共用，避免两处各算一遍）。 */
  effectiveDate: string;
  /** 生效分钟 = `finalMinutes ?? suggestedMinutes`。 */
  effectiveMinutes: number;
}

/** 任务草案（含逐日预算快照与超支明细）。 */
export interface TaskProposalDto {
  id: string;
  materialId: string;
  packId: string | null;
  baseDate: string;
  /** 基准日预算快照（生成草案时的值）。 */
  budgetMinutes: number;
  totalMinutes: number;
  overflowDays: number;
  status: string;
  rationale: string | null;
  items: ProposalItemDto[];
  /** 基准日起 7 天的预算（现查，不是快照）。 */
  days: { date: string; minutes: number; isRestDay: boolean }[];
  /** 按生效值算出的逐日超支明细（空 = 未超支）。 */
  violations: { date: string; budgetMinutes: number; allocatedMinutes: number }[];
  createdAt: string;
}

/**
 * 读材料包（条目按 `sortOrder` 展开，被引用对象**批量**解析）。
 *
 * 为什么按 `itemType` 分三组批量查而不是逐条查：一个包有 20+ 个引用，
 * 逐条查就是 20+ 次往返；分类型各一次 `IN` 就够。
 *
 * @param id 材料 id
 */
export async function getMaterialPack(id: string): Promise<MaterialPackDto | null> {
  const material = await prisma.learningMaterial.findUnique({
    where: { id },
    select: { id: true, difficultyEstimate: true },
  });
  if (!material) return null;

  const pack = await prisma.materialPack.findUnique({
    where: { materialId: id },
    select: {
      id: true,
      learningGoalsJson: true,
      targetSkillsJson: true,
      difficultyEstimate: true,
      estimatedMinutes: true,
      summaryId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!pack) {
    return {
      materialId: id,
      packId: null,
      learningGoals: [],
      targetSkills: [],
      difficultyEstimate: material.difficultyEstimate ?? null,
      estimatedMinutes: 0,
      summary: null,
      items: [],
      createdAt: null,
      updatedAt: null,
    };
  }

  const rows = await prisma.materialPackItem.findMany({
    where: { packId: pack.id },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      itemType: true,
      refId: true,
      sortOrder: true,
      estimatedMinutes: true,
      note: true,
    },
  });

  const refIdsByType = new Map<string, string[]>();
  for (const row of rows) {
    const list = refIdsByType.get(row.itemType) ?? [];
    list.push(row.refId);
    refIdsByType.set(row.itemType, list);
  }

  const [chunks, sets, candidates, extractions, summaryRow] = await Promise.all([
    refIdsByType.has('CHUNK')
      ? prisma.contentChunk.findMany({
          where: { id: { in: refIdsByType.get('CHUNK') ?? [] } },
          select: { id: true, seq: true, headingPath: true },
        })
      : Promise.resolve([]),
    refIdsByType.has('EXERCISE_SET')
      ? prisma.materialExerciseSet.findMany({
          where: { id: { in: refIdsByType.get('EXERCISE_SET') ?? [] } },
          select: {
            id: true,
            title: true,
            targetSkill: true,
            estimatedMinutes: true,
            _count: { select: { exercises: true } },
          },
        })
      : Promise.resolve([]),
    refIdsByType.has('VOCAB_CANDIDATE')
      ? prisma.vocabularyCandidate.findMany({
          where: { id: { in: refIdsByType.get('VOCAB_CANDIDATE') ?? [] } },
          select: { id: true, lemma: true },
        })
      : Promise.resolve([]),
    refIdsByType.has('EXTRACTION') || refIdsByType.has('SENTENCE')
      ? prisma.extractionResult.findMany({
          where: {
            id: {
              in: [
                ...(refIdsByType.get('EXTRACTION') ?? []),
                ...(refIdsByType.get('SENTENCE') ?? []),
              ],
            },
          },
          select: { id: true, kind: true },
        })
      : Promise.resolve([]),
    pack.summaryId
      ? prisma.extractionResult.findUnique({
          where: { id: pack.summaryId },
          select: { id: true, payloadJson: true, editedPayloadJson: true },
        })
      : Promise.resolve(null),
  ]);

  const chunkById = new Map(chunks.map((row) => [row.id, row]));
  const setById = new Map(sets.map((row) => [row.id, row]));
  const candidateById = new Map(candidates.map((row) => [row.id, row]));
  const extractionById = new Map(extractions.map((row) => [row.id, row]));

  const vocabTotal = await prisma.vocabularyCandidate.count({
    where: { materialId: id, reviewStatus: { in: ['accepted', 'edited'] } },
  });

  const items: PackItemDto[] = rows.map((row) => {
    const base = {
      id: row.id,
      itemType: row.itemType,
      refId: row.refId,
      sortOrder: row.sortOrder,
      estimatedMinutes: row.estimatedMinutes,
      note: row.note,
    };

    if (row.itemType === 'CHUNK') {
      const chunk = chunkById.get(row.refId);
      if (!chunk) {
        return { ...base, label: '精读段落', secondary: null, missing: true, href: null };
      }
      return {
        ...base,
        label: `第 ${chunk.seq} 段`,
        secondary: chunk.headingPath ?? null,
        missing: false,
        href: `/materials/${id}/read`,
      };
    }

    if (row.itemType === 'EXERCISE_SET') {
      const set = setById.get(row.refId);
      if (!set) {
        return { ...base, label: '练习集', secondary: null, missing: true, href: null };
      }
      return {
        ...base,
        label: `${set.targetSkill} 练习：${set.title}`,
        secondary: `${set._count.exercises} 道题 · 约 ${set.estimatedMinutes} 分钟`,
        missing: false,
        href: `/materials/${id}/exercises/${set.id}`,
      };
    }

    if (row.itemType === 'VOCAB_CANDIDATE') {
      const candidate = candidateById.get(row.refId);
      if (!candidate) {
        return { ...base, label: '词汇复习', secondary: null, missing: true, href: null };
      }
      return {
        ...base,
        label: '词汇候选复习',
        secondary: `本材料共 ${vocabTotal} 条已确认候选（示例：${candidate.lemma}）`,
        missing: false,
        href: `/materials/${id}/vocabulary`,
      };
    }

    const extraction = extractionById.get(row.refId);
    if (!extraction) {
      return { ...base, label: '分析结果', secondary: null, missing: true, href: null };
    }
    const kindLabel =
      MATERIAL_EXTRACTION_KIND_LABELS_ZH[extraction.kind as MaterialExtractionKind] ??
      extraction.kind;
    return {
      ...base,
      label: kindLabel,
      secondary: row.note,
      missing: false,
      href: `/materials/${id}/analysis`,
    };
  });

  const summaryPayload = summaryRow
    ? parseJson<Record<string, unknown>>(summaryRow.editedPayloadJson ?? summaryRow.payloadJson, {})
    : null;

  return {
    materialId: id,
    packId: pack.id,
    learningGoals: parseStringArray(pack.learningGoalsJson),
    targetSkills: parseStringArray(pack.targetSkillsJson),
    difficultyEstimate: pack.difficultyEstimate ?? null,
    estimatedMinutes: pack.estimatedMinutes,
    summary:
      summaryRow && summaryPayload && typeof summaryPayload.summary_zh === 'string'
        ? { extractionId: summaryRow.id, summaryZh: summaryPayload.summary_zh }
        : summaryRow
          ? { extractionId: summaryRow.id, summaryZh: '' }
          : null,
    items,
    createdAt: pack.createdAt.toISOString(),
    updatedAt: pack.updatedAt.toISOString(),
  };
}

/**
 * 读任务草案（缺省取最近一条 `draft`）。
 *
 * @param materialId 材料 id
 * @param proposalId 指定草案（用于确认后回看）
 */
export async function getTaskProposal(
  materialId: string,
  proposalId?: string,
): Promise<TaskProposalDto | null> {
  const proposal = proposalId
    ? await prisma.taskProposal.findFirst({ where: { id: proposalId, materialId } })
    : await prisma.taskProposal.findFirst({
        where: { materialId, status: 'draft' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
  if (!proposal) return null;

  const rows = await prisma.taskProposalItem.findMany({
    where: { proposalId: proposal.id },
    orderBy: [{ suggestedDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      module: true,
      targetSkill: true,
      title: true,
      suggestedMinutes: true,
      finalMinutes: true,
      suggestedDate: true,
      finalDate: true,
      granularity: true,
      reason: true,
      exerciseIdsJson: true,
      selected: true,
      planTaskId: true,
    },
  });

  const items: ProposalItemDto[] = rows.map((row) => ({
    id: row.id,
    module: row.module,
    targetSkill: row.targetSkill,
    title: row.title,
    suggestedMinutes: row.suggestedMinutes,
    finalMinutes: row.finalMinutes,
    suggestedDate: row.suggestedDate,
    finalDate: row.finalDate,
    granularity: row.granularity,
    reason: row.reason,
    exerciseIds: parseStringArray(row.exerciseIdsJson),
    selected: row.selected,
    planTaskId: row.planTaskId,
    effectiveDate: row.finalDate ?? row.suggestedDate,
    effectiveMinutes: row.finalMinutes ?? row.suggestedMinutes,
  }));

  // 逐日预算现查（用户可能在草案生成后改过日程）
  const days = await Promise.all(
    listDateRange(proposal.baseDate, addDays(proposal.baseDate, 6)).map(async (date) => {
      const budget = await getEffectiveBudget(date);
      return { date, minutes: budget.minutes, isRestDay: budget.isRestDay };
    }),
  );
  const check = validateProposalAgainstBudget(
    items.map((item) => ({ date: item.effectiveDate, minutes: item.effectiveMinutes })),
    days,
  );

  return {
    id: proposal.id,
    materialId: proposal.materialId,
    packId: proposal.packId,
    baseDate: proposal.baseDate,
    budgetMinutes: proposal.budgetMinutes,
    totalMinutes: proposal.totalMinutes,
    overflowDays: proposal.overflowDays,
    status: proposal.status,
    rationale: proposal.rationale,
    items,
    days,
    violations: check.violations,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/** 权限留痕（只读，按时间倒序；`action`/`rule` 是原始英文枚举，页面配中文标签）。 */
export interface MaterialPermissionRecordDto {
  id: string;
  action: string;
  rule: string;
  note: string | null;
  createdAt: string;
}

/**
 * 读材料的权限留痕。
 *
 * 为什么必须展示：导出被拦、权属确认这些动作的价值就在"事后能查"。
 * 只写不读的审计表等于没有审计 —— 用户和我们都无法证明当时发生了什么。
 *
 * @param id 材料 id
 * @param limit 最多几条（默认 20，页面是回看不是全量导出）
 */
export async function listMaterialPermissionRecords(
  id: string,
  limit = 20,
): Promise<MaterialPermissionRecordDto[]> {
  const rows = await prisma.materialPermissionRecord.findMany({
    where: { materialId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(200, limit)),
    select: { id: true, action: true, rule: true, note: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    rule: row.rule,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }));
}
