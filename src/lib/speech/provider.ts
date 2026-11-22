/**
 * v2.5 ASR / 语音服务 Provider Adapter（可替换抽象）。
 *
 * 设计原则（约束 §9 / v2.5 需求 §9）：
 * - ASR 不绑定具体供应商，通过 `SpeechProvider` 接口接入；
 * - 无外部 ASR 时**必须**提供手动转写降级（`UnavailableAsrProvider` 明确返回不可用，
 *   调用方据此提示用户手动提交转写）；
 * - 机器转写与用户修订版分版本保存（`Transcript.kind`）；
 * - 低置信度转写必须提示核验，不得当作 ground truth；
 * - 绝不把 ASR 转写准确率当成发音分数。
 */

export interface AsrTranscriptSegment {
  seq: number;
  startMs?: number;
  endMs?: number;
  text: string;
  confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface AsrResult {
  ok: true;
  provider: string;
  model: string;
  language: string;
  segments: AsrTranscriptSegment[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  latencyMs: number;
  costUsd?: number;
}

export interface AsrUnavailable {
  ok: false;
  provider: string;
  reason: 'NO_PROVIDER' | 'NOT_CONFIGURED' | 'TIMEOUT' | 'PROVIDER_ERROR';
  message: string;
}

export type AsrOutcome = AsrResult | AsrUnavailable;

export interface SpeechProvider {
  readonly name: string;
  readonly capability: 'asr' | 'tts' | 'pronunciation';
  readonly available: boolean;
  transcribe(audio: { mimeType: string; buffer: Buffer }, options?: { language?: string }): Promise<AsrOutcome>;
}

/**
 * 未配置外部 ASR 时的降级 Provider：明确返回不可用，
 * 由上层触发「手动转写」路径。绝不抛异常。
 */
export class UnavailableAsrProvider implements SpeechProvider {
  readonly name = 'unavailable';
  readonly capability = 'asr' as const;
  readonly available = false;

  async transcribe(): Promise<AsrOutcome> {
    return {
      ok: false,
      provider: this.name,
      reason: 'NO_PROVIDER',
      message: '未配置外部 ASR 服务，请手动提交转写。',
    };
  }
}

/**
 * 运行时解析当前 ASR Provider。
 *
 * 当前实现：项目尚未接入真实 ASR 供应商（无外部语音服务凭据），
 * 因此恒返回不可用 Provider，强制走手动转写降级——这是**有意的安全默认**，
 * 而非缺陷。接入真实 ASR 时，在此按 `AI_PROVIDER` 环境变量 / 数据库凭据切换即可，
 * 业务层无需改动。
 */
export function resolveAsrProvider(): SpeechProvider {
  return new UnavailableAsrProvider();
}

/** 判断一次 ASR 结果是否成功可用。 */
export function isAsrSuccess(outcome: AsrOutcome): outcome is AsrResult {
  return outcome.ok === true;
}
