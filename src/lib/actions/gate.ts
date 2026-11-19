'use server';

/**
 * 阶段门禁复核 Action（T34 配套）。
 *
 * 只读复核：返回 H1–H5 的未满足项与建议，**绝不自动切换阶段**。
 * 真正的流转必须由用户在「阶段与验收」里手动确认（写 `StageTransitionLog`）。
 */

import { evaluateGateSchema } from '@/lib/schema/stage';
import { failValidation, ok } from '@/lib/result';
import { getStageGate } from '@/lib/queries/stages';
import type { ActionResult, GateResult } from '@/lib/types';

/** 重新计算某阶段的 H1–H5 门禁。 */
export async function evaluateGateAction(raw: unknown): Promise<ActionResult<GateResult>> {
  const parsed = evaluateGateSchema.safeParse(raw);
  if (!parsed.success) return failValidation(parsed.error);

  const gate = await getStageGate(parsed.data.stageId);
  if (!gate) {
    return { ok: false, code: 'NOT_FOUND', error: '阶段不存在' };
  }
  return ok(gate);
}
