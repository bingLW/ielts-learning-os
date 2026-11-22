'use client';

/**
 * Speaking Lab 页面主体：录音工作区 + 口语题目 + 会话记录。
 * 录音：MediaRecorder → webm → 上传落盘；回放、重录保留历史 take。
 */

import { useCallback, useRef, useState } from 'react';
import type { SpeakingPromptDto, SpeakingSessionDto } from '@/lib/queries/listening';
import { SPEAKING_TASK_TYPE_LABELS_ZH, type SpeakingTaskType } from '@/lib/constants';

interface Props {
  prompts: SpeakingPromptDto[];
  sessions: SpeakingSessionDto[];
}

export function SpeakingPageBody({ prompts, sessions }: Props) {
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setRecording(true);
    } catch {
      setPermissionError('无法访问麦克风。请在浏览器中允许麦克风权限后重试。');
    }
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const uploadRecording = useCallback(async () => {
    if (!audioUrl) return;
    setUploading(true);
    setMessage(null);
    try {
      const blob = await fetch(audioUrl).then((res) => res.blob());
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');
      const res = await fetch('/api/upload-recording', { method: 'POST', body: formData });
      const json = await res.json();
      if (!json.ok) setMessage(json.error ?? '上传失败');
      else {
        setMessage('录音已保存');
        window.location.reload();
      }
    } catch {
      setMessage('上传失败');
    } finally {
      setUploading(false);
    }
  }, [audioUrl]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">口语实验室</h1>
          <p className="text-sm text-inkMuted">选择题目 → 录音 → 回放 → 重录 → 转写/反馈</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 tablet:grid-cols-2">
        <div className="rounded-xl border border-ink/10 p-4">
          <h2 className="mb-3 text-sm font-medium text-ink">录音工作区</h2>
          <p className="mb-2 text-xs text-inkMuted">
            录音前请确认数据用途：录音仅保存在本机，若调用外部 AI 会先征求你的同意。
          </p>
          <div className="flex items-center gap-2">
            {!recording ? (
              <button
                type="button"
                onClick={startRecording}
                className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                开始录音
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="rounded-lg bg-egRed px-4 py-2 text-sm font-medium text-white"
              >
                停止
              </button>
            )}
            {audioUrl && (
              <button
                type="button"
                onClick={uploadRecording}
                disabled={uploading}
                className="rounded-lg border border-ink/10 px-4 py-2 text-sm disabled:opacity-50"
              >
                {uploading ? '保存中…' : '保存录音'}
              </button>
            )}
          </div>
          {permissionError && <p className="mt-2 text-sm text-egRed">{permissionError}</p>}
          {message && <p className="mt-2 text-sm text-inkMuted">{message}</p>}
          {audioUrl && (
            <div className="mt-3">
              <audio src={audioUrl} controls className="w-full" />
              <p className="mt-1 text-xs text-inkMuted">重录会保留历史版本，不会覆盖之前的录音。</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-ink/10 p-4">
          <h2 className="mb-3 text-sm font-medium text-ink">口语题目</h2>
          {prompts.length === 0 ? (
            <p className="text-sm text-inkMuted">暂无题目。</p>
          ) : (
            <div className="flex flex-col gap-2">
              {prompts.slice(0, 5).map((prompt) => (
                <div key={prompt.id} className="rounded-lg bg-ink/5 p-3">
                  <span className="mr-2 rounded bg-ink/10 px-2 py-0.5 text-xs text-inkMuted">
                    {SPEAKING_TASK_TYPE_LABELS_ZH[prompt.taskType as SpeakingTaskType] ?? prompt.taskType}
                  </span>
                  <span className="text-sm font-medium text-ink">{prompt.title}</span>
                  <p className="mt-1 text-sm text-inkMuted">{prompt.prompt}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-ink/10 p-4">
        <h2 className="mb-3 text-sm font-medium text-ink">会话记录</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-inkMuted">暂无会话。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <div key={session.id} className="rounded-lg border border-ink/10 p-3">
                <p className="text-xs text-inkMuted">
                  {session.mode} · {session.turns.length} 轮 · {session.recordings.length} 段录音
                </p>
                {session.turns.map((turn) => (
                  <p key={turn.id} className="mt-1 text-sm text-ink">
                    <span className="mr-2 text-xs text-inkMuted">{turn.role === 'USER' ? '我' : 'AI'}</span>
                    {turn.text ?? '(录音)'}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
