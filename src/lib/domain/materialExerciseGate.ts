/**
 * 材料练习的两道闸门（纯函数，ADR-08 的"单点裁决"）。
 *
 * 一个问题：一道材料题**什么时候可以被用来做什么**？答案必须只有一处，
 * 否则「这道题能不能排进计划」「这次作答能不能挂证据」会散落在 action、页面、
 * 报表里各写一遍，迟早互相矛盾。所以这里做成零 IO 纯函数：输入是审核状态
 * （和请求的证据类型），输出是布尔结论 + 一句人话原因。
 *
 * 三条规则：
 * 1. **只有 `approved` 能进正式排程/测评**（`canEnterPlacement`）。
 *    `draft` / `needs_review` 是 AI 刚生成、人还没看过的题 —— 拿它去评估水平
 *    等于用未校验的尺子量身高。
 * 2. **未知状态一律按"拒绝"处理**（fail-closed）。数据库里可能因为历史数据、
 *    手工 SQL、将来新增状态而出现 `'APPROVED '`、`''`、`null` 这类值；
 *    判成"允许"会让闸门形同虚设，判成"拒绝"最多是少给一个功能。
 * 3. **`BASELINE` 永远不允许**（ADR-08）。基线必须来自独立性任务，
 *    材料客观题（尤其 AI 生成、可回查原文的题）不构成基线证据。
 *    注意 `MATERIAL_ATTEMPT_EVIDENCE_TYPES` 里本来就没有 `BASELINE` ——
 *    这里显式再拦一次，防止将来有人"补齐"这个枚举时把闸门绕过去。
 */

import {
  MATERIAL_ATTEMPT_EVIDENCE_TYPES,
  MATERIAL_EXERCISE_REVIEW_STATUSES,
  type MaterialAttemptEvidenceType,
  type MaterialExerciseReviewStatus,
} from '@/lib/constants';

/** 允许作答的审核状态（"低风险练习"）：草稿、待复核、已审核通过。 */
const LOW_RISK_PRACTICE_STATUSES: readonly MaterialExerciseReviewStatus[] = [
  'draft',
  'needs_review',
  'approved',
];

/** 唯一允许进入正式排程/测评的审核状态。 */
const PLACEMENT_STATUS: MaterialExerciseReviewStatus = 'approved';

/** 任何审核状态下都允许挂载的证据类型（练习留痕，但不是独立证据）。 */
const ALWAYS_ATTACHABLE: readonly MaterialAttemptEvidenceType[] = ['PRACTICE_ONLY'];

/** 只有题目已审核通过才允许挂载的证据类型。 */
const APPROVED_ONLY_ATTACHABLE: readonly MaterialAttemptEvidenceType[] = [
  'ASSISTED',
  'IMMEDIATE_RETEST',
];

/**
 * 永远不允许出现在材料题上的证据类型（ADR-08）。
 *
 * 用 `string[]` 而不是 `MaterialAttemptEvidenceType[]`：`BASELINE` 现在不在
 * 枚举里，将来若有人加进去，这个拦截依然生效（类型不该成为安全边界）。
 */
const FORBIDDEN_EVIDENCE_TYPES: readonly string[] = ['BASELINE'];

/**
 * 归一化审核状态：大小写/空白容错，未知值返回 `null`。
 *
 * @param value 数据库或入参里的原始值
 */
export function normalizeExerciseReviewStatus(
  value: unknown,
): MaterialExerciseReviewStatus | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const known = MATERIAL_EXERCISE_REVIEW_STATUSES as readonly string[];
  return known.includes(trimmed) ? (trimmed as MaterialExerciseReviewStatus) : null;
}

/**
 * 是否允许这道题进入正式排程 / 测评 / 证据链。
 *
 * @param reviewStatus 题目的审核状态（未知值视为拒绝）
 */
export function canEnterPlacement(reviewStatus: string | null | undefined): boolean {
  return normalizeExerciseReviewStatus(reviewStatus) === PLACEMENT_STATUS;
}

/**
 * 是否允许"低风险练习"作答。
 *
 * 判据是审核状态本身，与用户是谁、从哪个入口进来无关 —— 拒绝/退役的题
 * 一律不给作答入口（做了也不算数，只会让用户白花时间）。
 *
 * @param reviewStatus 题目的审核状态（未知值视为拒绝）
 */
export function isLowRiskPracticeAllowed(reviewStatus: string | null | undefined): boolean {
  const normalized = normalizeExerciseReviewStatus(reviewStatus);
  return normalized !== null && LOW_RISK_PRACTICE_STATUSES.includes(normalized);
}

/**
 * 这次作答是否可以挂载指定类型的证据。
 *
 * - `PRACTICE_ONLY`：任何审核状态都可以（它本来就只是"我练过"的留痕）；
 * - `ASSISTED` / `IMMEDIATE_RETEST`：必须 `approved`（否则等于用未审核的题产生证据）；
 * - `BASELINE`：**永远 false**（ADR-08）；
 * - 其它未知值：false（fail-closed）。
 *
 * @param evidenceType 请求挂载的证据类型
 * @param reviewStatus 题目的审核状态
 */
export function canAttachEvidence(
  evidenceType: string | null | undefined,
  reviewStatus: string | null | undefined,
): boolean {
  const type = typeof evidenceType === 'string' ? evidenceType.trim().toUpperCase() : '';
  if (type.length === 0) return false;
  if (FORBIDDEN_EVIDENCE_TYPES.includes(type)) return false;
  if ((ALWAYS_ATTACHABLE as readonly string[]).includes(type)) return true;
  if ((APPROVED_ONLY_ATTACHABLE as readonly string[]).includes(type)) {
    return canEnterPlacement(reviewStatus);
  }
  return false;
}

/**
 * 解析"这次作答实际能挂什么证据"。
 *
 * 返回值是**落库值**而不是请求值：非法请求要么降级为 `PRACTICE_ONLY`
 * （未知值），要么直接返回 `null`（明确禁止的 `BASELINE`），
 * 让调用方无法"请求什么就写什么"。
 *
 * @param reviewStatus 题目的审核状态
 * @param requested 调用方请求的证据类型（缺省为 `PRACTICE_ONLY`）
 */
export function resolveAttemptEvidenceType(
  reviewStatus: string | null | undefined,
  requested?: string | null,
): MaterialAttemptEvidenceType | null {
  const wanted = typeof requested === 'string' ? requested.trim().toUpperCase() : '';
  if (FORBIDDEN_EVIDENCE_TYPES.includes(wanted)) return null;

  const known = MATERIAL_ATTEMPT_EVIDENCE_TYPES as readonly string[];
  const candidate = known.includes(wanted)
    ? (wanted as MaterialAttemptEvidenceType)
    : ('PRACTICE_ONLY' as MaterialAttemptEvidenceType);

  return canAttachEvidence(candidate, reviewStatus) ? candidate : null;
}

/** 一次作答的可用性结论（页面直接渲染，不再自己判断）。 */
export interface ExerciseUseDecision {
  /** 是否允许作答。 */
  canPractice: boolean;
  /** 是否可以挂证据。 */
  canAttachEvidence: boolean;
  /** 实际会落库的证据类型（不可挂时为 null）。 */
  evidenceType: MaterialAttemptEvidenceType | null;
  /** 是否允许进入正式排程/测评。 */
  canEnterPlacement: boolean;
  /** 不允许作答时的人话原因（允许时为 null）。 */
  reasonZh: string | null;
}

/**
 * 汇总一道题的可用性（作答入口、证据挂载、正式排程三件事一次说清）。
 *
 * @param reviewStatus 题目的审核状态
 * @param requested 请求挂载的证据类型（缺省按 `PRACTICE_ONLY`）
 */
export function decideExerciseUse(
  reviewStatus: string | null | undefined,
  requested?: string | null,
): ExerciseUseDecision {
  const normalized = normalizeExerciseReviewStatus(reviewStatus);
  const canPractice = isLowRiskPracticeAllowed(normalized);
  // 不可作答的题自然也不可能"挂证据"：连入口都没有，谈不上留痕
  const evidenceType = canPractice ? resolveAttemptEvidenceType(normalized, requested) : null;
  return {
    canPractice,
    canAttachEvidence: evidenceType !== null,
    evidenceType,
    canEnterPlacement: canEnterPlacement(normalized),
    reasonZh: canPractice ? null : reasonOf(normalized),
  };
}

/** 不可作答时的原因文案（`null` = 数据库里存了未知状态）。 */
function reasonOf(status: MaterialExerciseReviewStatus | null): string {
  if (status === 'rejected') return '这道题已被拒绝，不能作答（可请人工重新生成或换一道）';
  if (status === 'retired') return '这道题已退役，不再提供作答';
  if (status === null) return '这道题的审核状态无法识别，已按不允许作答处理（请联系维护者核对数据）';
  return '这道题当前不可作答';
}
