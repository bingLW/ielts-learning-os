'use client';

/**
 * 证据录入表单（Quick / Standard / Full 共用一张表单，用级别切换记录深度）。
 *
 * 关键交互：
 * - 「派生下一版本」时锁定 parent，技能沿用父证据，类型默认下一阶段。
 * - 基线只能是 A0、辅助版必须 A1–A4 —— 表单即时提示，服务端最终校验。
 * - 附件与纯文本二选一即可；A4 输出会明确标注「绝不计为独立产出」。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createEvidenceAction } from '@/lib/actions/evidence';
import {
  ASSESSOR_TYPES,
  ASSESSOR_TYPE_LABEL_ZH,
  ASSISTANCE_LEVELS,
  ASSISTANCE_LEVEL_LABEL_ZH,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_HINT_ZH,
  EVIDENCE_LEVEL_LABEL_ZH,
  EVIDENCE_PRIVACY_LABEL_ZH,
  EVIDENCE_PRIVACY_LEVELS,
  EVIDENCE_SKILLS,
  EVIDENCE_SKILL_LABEL_ZH,
  EVIDENCE_TYPE_LABEL_ZH,
  LEARNING_EVIDENCE_TYPES,
  LEARNING_EVIDENCE_TYPE_CODE,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
  RETEST_A0_NOTE_ZH,
  RETEST_TRANSFER_NOTE_ZH,
  RETEST_TYPE_LABEL_ZH,
} from '@/lib/constants';
import { checkTypeAssistance, maxEvidenceScore, nextChainType } from '@/lib/domain/evidence';
import type {
  AssistanceLevel,
  AssessorType,
  EvidenceConfidence,
  EvidenceDetailDto,
  EvidenceLevel,
  EvidencePrivacy,
  EvidenceSkill,
  LearningEvidenceType,
  RetestCompletionContextDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, selectClass, textareaClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';

export interface EvidenceFormProps {
  /** 从某条证据「派生下一版本」时传入；普通新建为 null。 */
  parent: EvidenceDetailDto | null;
  /** 从复测队列进入：锁定阶段与 A0，保存后把排期标记为已完成。 */
  retest?: RetestCompletionContextDto | null;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}

export function EvidenceForm({ parent, retest = null, onToast, onDone }: EvidenceFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [skill, setSkill] = useState<EvidenceSkill>(
    retest?.skill ?? parent?.skill ?? 'LISTENING',
  );
  const [evidenceType, setEvidenceType] = useState<LearningEvidenceType>(
    retest?.evidenceType ??
      (parent ? (nextChainType(parent.evidenceType) ?? 'IMMEDIATE_RETEST') : 'BASELINE'),
  );
  const [level, setLevel] = useState<EvidenceLevel>(retest?.level ?? parent?.level ?? 'QUICK');
  const [assistanceLevel, setAssistanceLevel] = useState<AssistanceLevel>(
    retest ? 'A0' : parent?.assistanceLevel ?? 'A0',
  );
  const [assessorType, setAssessorType] = useState<AssessorType>('SELF');
  const [confidence, setConfidence] = useState<EvidenceConfidence>('MEDIUM');
  const [privacyLevel, setPrivacyLevel] = useState<EvidencePrivacy>('PRIVATE');
  const [outputText, setOutputText] = useState('');
  const [score, setScore] = useState('');
  const [scoreReason, setScoreReason] = useState('');
  const [evidenceAnchor, setEvidenceAnchor] = useState('');
  const [note, setNote] = useState('');
  const [createdAtDate, setCreatedAtDate] = useState('');

  const [prompt, setPrompt] = useState('');
  const [materialSource, setMaterialSource] = useState('');
  const [timeLimitMinutes, setTimeLimitMinutes] = useState('');
  const [toolsAllowed, setToolsAllowed] = useState('');
  const [audience, setAudience] = useState('');
  const [environment, setEnvironment] = useState('');

  const [attachEnabled, setAttachEnabled] = useState(false);
  const [fileUri, setFileUri] = useState('');
  const [attachType, setAttachType] = useState<
    'RECORDING' | 'WRITING' | 'SCORE_SHEET' | 'COURSE_MATERIAL' | 'SCREENSHOT' | 'OTHER'
  >('RECORDING');
  const [attachNote, setAttachNote] = useState('');

  const typeCheck = checkTypeAssistance(evidenceType, assistanceLevel);
  const scoreCap = maxEvidenceScore(assistanceLevel);

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const condition =
        prompt || materialSource || timeLimitMinutes || toolsAllowed || audience || environment
          ? {
              prompt: prompt || undefined,
              materialSource: materialSource || undefined,
              timeLimitMinutes: timeLimitMinutes ? Number(timeLimitMinutes) : undefined,
              toolsAllowed: toolsAllowed
                ? toolsAllowed
                    .split(/[,，、\n]/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                : undefined,
              audience: audience || undefined,
              environment: environment || undefined,
            }
          : undefined;

      const result = await createEvidenceAction({
        skill,
        evidenceType,
        level,
        ...(parent ? { parentEvidenceId: parent.id } : {}),
        condition,
        outputText: outputText || undefined,
        ...(score !== '' ? { score: Number(score) } : {}),
        scoreReason: scoreReason || undefined,
        evidenceAnchor: evidenceAnchor || undefined,
        assistanceLevel,
        assessorType,
        confidence,
        privacyLevel,
        note: note || undefined,
        createdAtDate: createdAtDate || undefined,
        ...(retest ? { retestScheduleId: retest.scheduleId } : {}),
        ...(attachEnabled && fileUri
          ? {
              attachment: {
                fileUri,
                evidenceType: attachType,
                note: attachNote || undefined,
                privacyLevel,
              },
            }
          : {}),
      });

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }

      if (retest) {
        onToast(
          `${RETEST_TYPE_LABEL_ZH[retest.retestType]}已完成并保存为 A0 证据`,
          'success',
        );
        router.push('/retest');
        return;
      }

      onToast(
        parent
          ? `${LEARNING_EVIDENCE_TYPE_LABEL_ZH[evidenceType]}已保存（属于同一证据链，原版本未改动）`
          : `${LEARNING_EVIDENCE_TYPE_LABEL_ZH[evidenceType]}已保存`,
        'success',
      );
      onDone();
      router.refresh();
    });
  };

  return (
    <Card
      title={
        retest
          ? `完成复测：${RETEST_TYPE_LABEL_ZH[retest.retestType]}`
          : parent
            ? `派生下一版本：${LEARNING_EVIDENCE_TYPE_LABEL_ZH[parent.evidenceType]}`
            : '录入证据'
      }
      description={
        retest
          ? `到期 ${retest.dueDate} · 预计 ${retest.estMinutes} 分钟；技能与阶段已锁定，必须 A0 无辅助。`
          : parent
            ? `父证据保留原样；新版本会挂到同一证据链（parent_evidence_id）。`
            : '先留下原始样本，再谈提升；没有证据就不下结论。'
      }
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onDone}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
            {pending ? '保存中…' : '保存证据'}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {retest && (
          <div className="space-y-1 rounded border border-line bg-surfaceAlt px-2 py-1.5 text-[11px] text-inkMuted sm:col-span-2 xl:col-span-4">
            <p>{RETEST_A0_NOTE_ZH}</p>
            {retest.retestType === 'TRANSFER' && <p>{RETEST_TRANSFER_NOTE_ZH}</p>}
            {retest.parentPreview && (
              <p className="text-ink">
                参照父样本：{retest.parentPreview}
              </p>
            )}
          </div>
        )}

        <FormField label="技能" htmlFor="ev-skill" required error={fieldErrors.skill}>
          <select
            id="ev-skill"
            value={skill}
            onChange={(event) => setSkill(event.target.value as EvidenceSkill)}
            className={selectClass}
            disabled={Boolean(parent) || Boolean(retest)}
          >
            {EVIDENCE_SKILLS.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_SKILL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="证据类型" htmlFor="ev-type" required error={fieldErrors.evidenceType}>
          <select
            id="ev-type"
            value={evidenceType}
            onChange={(event) => setEvidenceType(event.target.value as LearningEvidenceType)}
            className={selectClass}
            disabled={Boolean(retest)}
          >
            {LEARNING_EVIDENCE_TYPES.map((item) => (
              <option key={item} value={item}>
                {LEARNING_EVIDENCE_TYPE_CODE[item]} {LEARNING_EVIDENCE_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="记录级别"
          htmlFor="ev-level"
          required
          hint={EVIDENCE_LEVEL_HINT_ZH[level]}
          error={fieldErrors.level}
        >
          <select
            id="ev-level"
            value={level}
            onChange={(event) => setLevel(event.target.value as EvidenceLevel)}
            className={selectClass}
          >
            {EVIDENCE_LEVELS.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_LEVEL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="辅助级别"
          htmlFor="ev-assist"
          required
          error={fieldErrors.assistanceLevel}
          hint="只有 A0 计入独立表现"
        >
          <select
            id="ev-assist"
            value={assistanceLevel}
            onChange={(event) => setAssistanceLevel(event.target.value as AssistanceLevel)}
            className={selectClass}
            disabled={Boolean(retest)}
          >
            {ASSISTANCE_LEVELS.map((item) => (
              <option key={item} value={item}>
                {ASSISTANCE_LEVEL_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        {!typeCheck.ok && (
          <p role="alert" className="text-[11px] font-medium text-red-700 sm:col-span-2 xl:col-span-4">
            {typeCheck.error}
          </p>
        )}
        {assistanceLevel === 'A4' && (
          <p className="text-[11px] text-red-700 sm:col-span-2 xl:col-span-4">
            A4 代写/代答/完整改写：绝不计为学习者独立产出，也不会被当作迁移或复测结果。
          </p>
        )}

        <FormField
          label="可见产出（正文）"
          htmlFor="ev-output"
          error={fieldErrors.outputText}
          className="sm:col-span-2 xl:col-span-4"
          hint="Quick 可只填这一段；也可改为下方附件。原始样本保存后不可覆盖。"
        >
          <textarea
            id="ev-output"
            value={outputText}
            onChange={(event) => setOutputText(event.target.value)}
            className={`${textareaClass} min-h-[96px]`}
            placeholder="例如：首听记录、作文原文、口语转写、阅读摘要……"
          />
        </FormField>

        <FormField label="内部评分（0–2，可选）" htmlFor="ev-score" error={fieldErrors.score} hint={`当前辅助级别最高 ${scoreCap} 分`}>
          <select
            id="ev-score"
            value={score}
            onChange={(event) => setScore(event.target.value)}
            className={selectClass}
          >
            <option value="">不评分</option>
            <option value="0">0 未完成/无证据</option>
            <option value="1">1 部分完成或依赖帮助</option>
            {scoreCap >= 2 && <option value="2">2 标明条件下独立完成</option>}
          </select>
        </FormField>

        <FormField label="评分理由 / 证据位置" htmlFor="ev-reason" error={fieldErrors.scoreReason}>
          <input
            id="ev-reason"
            value={scoreReason}
            onChange={(event) => setScoreReason(event.target.value)}
            className={inputClass}
            placeholder="例如：第 2 段主旨遗漏；01:24 词界未切分"
          />
        </FormField>

        <FormField label="证据位置" htmlFor="ev-anchor">
          <input
            id="ev-anchor"
            value={evidenceAnchor}
            onChange={(event) => setEvidenceAnchor(event.target.value)}
            className={inputClass}
            placeholder="句子 / 段落 / 时间戳 / 题号"
          />
        </FormField>

        <FormField label="评估者" htmlFor="ev-assessor">
          <select
            id="ev-assessor"
            value={assessorType}
            onChange={(event) => setAssessorType(event.target.value as AssessorType)}
            className={selectClass}
          >
            {ASSESSOR_TYPES.map((item) => (
              <option key={item} value={item}>
                {ASSESSOR_TYPE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="置信度" htmlFor="ev-confidence">
          <select
            id="ev-confidence"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as EvidenceConfidence)}
            className={selectClass}
          >
            {EVIDENCE_CONFIDENCES.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_CONFIDENCE_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="隐私等级" htmlFor="ev-privacy">
          <select
            id="ev-privacy"
            value={privacyLevel}
            onChange={(event) => setPrivacyLevel(event.target.value as EvidencePrivacy)}
            className={selectClass}
          >
            {EVIDENCE_PRIVACY_LEVELS.map((item) => (
              <option key={item} value={item}>
                {EVIDENCE_PRIVACY_LABEL_ZH[item]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="补录日期（可选）" htmlFor="ev-date" hint="仅补录历史样本时填写">
          <input
            id="ev-date"
            type="date"
            value={createdAtDate}
            onChange={(event) => setCreatedAtDate(event.target.value)}
            className={inputClass}
          />
        </FormField>

        <div className="sm:col-span-2 xl:col-span-4">
          <p className="mb-1 text-xs font-medium text-ink">条件快照（记录「在什么条件下完成」）</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <FormField
              label={retest?.retestType === 'TRANSFER' ? '新任务 / 新提示语（必须换题）' : '任务 / 提示语'}
              htmlFor="ev-prompt"
              hint={
                retest?.parentPrompt
                  ? `原题：${retest.parentPrompt.slice(0, 80)}${retest.parentPrompt.length > 80 ? '…' : ''}`
                  : undefined
              }
            >
              <input id="ev-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} className={inputClass} />
            </FormField>
            <FormField label="材料来源" htmlFor="ev-material">
              <input
                id="ev-material"
                value={materialSource}
                onChange={(event) => setMaterialSource(event.target.value)}
                className={inputClass}
                placeholder="教材 / 音频 / 文章版本"
              />
            </FormField>
            <FormField label="时间限制（分钟）" htmlFor="ev-limit">
              <input
                id="ev-limit"
                type="number"
                min={0}
                max={600}
                value={timeLimitMinutes}
                onChange={(event) => setTimeLimitMinutes(event.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label="允许的工具" htmlFor="ev-tools" hint="逗号分隔，例如：词典, 英文字幕">
              <input
                id="ev-tools"
                value={toolsAllowed}
                onChange={(event) => setToolsAllowed(event.target.value)}
                className={inputClass}
              />
            </FormField>
            <FormField label="受众 / 听众" htmlFor="ev-audience">
              <input id="ev-audience" value={audience} onChange={(event) => setAudience(event.target.value)} className={inputClass} />
            </FormField>
            <FormField label="设备 / 环境" htmlFor="ev-env">
              <input
                id="ev-env"
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
                className={inputClass}
                placeholder="耳机 / 安静房间 / 手机"
              />
            </FormField>
          </div>
        </div>

        <FormField label="附件" className="sm:col-span-2 xl:col-span-4" hint="第一期只保存受控文件引用（本地 URI），默认私有">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={attachEnabled}
              onChange={(event) => setAttachEnabled(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            附加录音 / 作文 / 评分单等文件
          </label>
        </FormField>

        {attachEnabled && (
          <>
            <FormField label="文件地址" htmlFor="ev-file" className="sm:col-span-2" error={fieldErrors['attachment.fileUri']}>
              <input
                id="ev-file"
                value={fileUri}
                onChange={(event) => setFileUri(event.target.value)}
                className={inputClass}
                placeholder="本地路径或受控链接"
              />
            </FormField>
            <FormField label="附件类型" htmlFor="ev-file-type">
              <select
                id="ev-file-type"
                value={attachType}
                onChange={(event) => setAttachType(event.target.value as typeof attachType)}
                className={selectClass}
              >
                {(['RECORDING', 'WRITING', 'SCORE_SHEET', 'COURSE_MATERIAL', 'SCREENSHOT', 'OTHER'] as const).map(
                  (item) => (
                    <option key={item} value={item}>
                      {EVIDENCE_TYPE_LABEL_ZH[item]}
                    </option>
                  ),
                )}
              </select>
            </FormField>
            <FormField label="附件备注" htmlFor="ev-file-note">
              <input
                id="ev-file-note"
                value={attachNote}
                onChange={(event) => setAttachNote(event.target.value)}
                className={inputClass}
              />
            </FormField>
          </>
        )}

        <FormField label="备注" htmlFor="ev-note" className="sm:col-span-2 xl:col-span-4">
          <textarea id="ev-note" value={note} onChange={(event) => setNote(event.target.value)} className={textareaClass} />
        </FormField>
      </div>

      {parent && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-inkMuted">
          <Icon name="repeat" size={12} />
          父证据 {LEARNING_EVIDENCE_TYPE_CODE[parent.evidenceType]} · {parent.outputPreview ?? '（无正文）'}
        </p>
      )}
    </Card>
  );
}
