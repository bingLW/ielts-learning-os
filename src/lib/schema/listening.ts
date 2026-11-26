/**
 * v2.5 Listening & Speaking Lab 的输入契约（Server Action 入口校验）。
 */

import { z } from 'zod';
import {
  LISTENING_ERROR_TYPES,
  LISTENING_MODES,
  SPEAKING_SESSION_MODES,
  SPEAKING_TASK_TYPES,
} from '@/lib/constants';
import { enumFrom } from './common';

const listeningMode = enumFrom(LISTENING_MODES, '听力模式');
const listeningErrorType = enumFrom(LISTENING_ERROR_TYPES, '听力错误类型');
const speakingTaskType = enumFrom(SPEAKING_TASK_TYPES, '口语任务类型');
const speakingSessionMode = enumFrom(SPEAKING_SESSION_MODES, '口语会话模式');

/** 上传音频元数据（文件体走 multipart，这里只校验元字段）。 */
export const audioAssetCreateSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  source: enumFrom(['UPLOAD', 'MATERIAL', 'INTERNAL', 'EXTERNAL_URL'] as const, '音源类型').optional(),
  language: z.string().max(20).optional(),
  dialectTag: z.string().max(40).optional(),
  rightsInfo: z.string().max(200).optional(),
  fileName: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  durationSec: z.number().int().nonnegative().optional(),
});
export type AudioAssetCreateInput = z.infer<typeof audioAssetCreateSchema>;

/** 资产删除预览：只读，不提交文件路径或删除标记。 */
export const assetDeletionPreviewSchema = z.object({
  kind: z.enum(['audio', 'recording'], '资产类型'),
  assetId: z.string().min(1).max(200),
  reason: z.string().trim().min(1, '请填写删除原因').max(500),
});
export type AssetDeletionPreviewInput = z.infer<typeof assetDeletionPreviewSchema>;

/** 删除必须绑定当次预览与明确文字确认；服务端在事务内再次核验。 */
export const assetDeletionConfirmSchema = assetDeletionPreviewSchema.extend({
  previewToken: z.string().min(20).max(5000),
  confirmation: z.literal('确认删除', '请输入“确认删除”'),
});
export type AssetDeletionConfirmInput = z.infer<typeof assetDeletionConfirmSchema>;

/** 创建听力练习。 */
export const listeningExerciseCreateSchema = z.object({
  audioAssetId: z.string().min(1),
  mode: listeningMode,
  title: z.string().min(1).max(200),
  prompt: z.string().max(2000).optional(),
});
export type ListeningExerciseCreateInput = z.infer<typeof listeningExerciseCreateSchema>;

/** 提交听力作答（首听结果与辅助后结果分离）。 */
export const listeningAttemptSubmitSchema = z.object({
  exerciseId: z.string().min(1),
  firstListenResult: z.string().max(4000).optional(),
  assistedResult: z.string().max(4000).optional(),
  replayCount: z.number().int().nonnegative().optional(),
});
export type ListeningAttemptSubmitInput = z.infer<typeof listeningAttemptSubmitSchema>;

/** 听力错误录入。 */
export const listeningErrorCreateSchema = z.object({
  attemptId: z.string().min(1),
  errorType: listeningErrorType,
  isTechnical: z.boolean().optional(),
  note: z.string().max(500).optional(),
});
export type ListeningErrorCreateInput = z.infer<typeof listeningErrorCreateSchema>;

/** 手动/修订转写。 */
export const transcriptUpsertSchema = z.object({
  audioAssetId: z.string().optional(),
  recordingAssetId: z.string().optional(),
  kind: enumFrom(['MACHINE', 'MANUAL', 'REVISED'] as const, '转写类型').optional(),
  language: z.string().max(20).optional(),
  confidence: enumFrom(['LOW', 'MEDIUM', 'HIGH'] as const, '置信度').optional(),
  segments: z
    .array(
      z.object({
        seq: z.number().int().nonnegative(),
        startMs: z.number().int().nonnegative().optional(),
        endMs: z.number().int().nonnegative().optional(),
        text: z.string().min(1).max(2000),
      }),
    )
    .min(1, '转写至少需要一个片段'),
});
export type TranscriptUpsertInput = z.infer<typeof transcriptUpsertSchema>;

/** 创建口语题目。 */
export const speakingPromptCreateSchema = z.object({
  taskType: speakingTaskType,
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
});
export type SpeakingPromptCreateInput = z.infer<typeof speakingPromptCreateSchema>;

/** 创建口语会话。 */
export const speakingSessionCreateSchema = z.object({
  promptId: z.string().optional(),
  mode: speakingSessionMode.optional(),
});
export type SpeakingSessionCreateInput = z.infer<typeof speakingSessionCreateSchema>;

/** 新增口语轮次。 */
export const speakingTurnCreateSchema = z.object({
  sessionId: z.string().min(1),
  role: enumFrom(['USER', 'AI'] as const, '角色'),
  text: z.string().max(8000).optional(),
  recordingAssetId: z.string().optional(),
  transcriptId: z.string().optional(),
});
export type SpeakingTurnCreateInput = z.infer<typeof speakingTurnCreateSchema>;
