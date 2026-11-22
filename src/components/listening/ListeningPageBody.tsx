'use client';

/**
 * Listening Lab 页面主体：音频上传 + 播放器 + 练习 + 转写对照。
 * 播放器支持：播放/暂停、速度、A-B 循环、逐句跳转。
 */

import { useCallback, useRef, useState } from 'react';
import type { AudioAssetDto, ListeningExerciseDto, TranscriptDto } from '@/lib/queries/listening';
import { LISTENING_MODE_LABELS_ZH, LISTENING_MODES, type ListeningMode } from '@/lib/constants';

interface Props {
  assets: AudioAssetDto[];
  exercises: ListeningExerciseDto[];
  transcripts: Record<string, TranscriptDto[]>;
}

export function ListeningPageBody({ assets, exercises, transcripts }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(assets[0]?.id ?? null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;
  const selectedTranscripts = selected ? transcripts[selected.id] ?? [] : [];
  const relatedExercises = exercises.filter((exercise) => exercise.audioAssetId === selectedId);

  const onUpload = useCallback(async (file: File) => {
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append(
        'meta',
        JSON.stringify({ title: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, mimeType: file.type }),
      );
      const res = await fetch('/api/upload-audio', { method: 'POST', body: formData });
      const json = await res.json();
      if (!json.ok) {
        setMessage(json.error ?? '上传失败');
      } else {
        setMessage('上传成功');
        window.location.reload();
      }
    } catch {
      setMessage('上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">听力实验室</h1>
          <p className="text-sm text-inkMuted">上传音频 → 盲听 → 作答 → 转写对照 → 听写 → 复述</p>
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {uploading ? '上传中…' : '上传音频'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg,.aac"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onUpload(file);
            event.target.value = '';
          }}
        />
      </div>

      {message && <p className="text-sm text-inkMuted">{message}</p>}

      {assets.length === 0 ? (
        <div className="rounded-xl border border-ink/10 p-8 text-center text-sm text-inkMuted">
          还没有音频。上传一个 mp3 / wav / m4a 开始练习。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 tablet:grid-cols-3">
          <div className="flex flex-col gap-2 tablet:col-span-1">
            <h2 className="text-sm font-medium text-ink">音源库</h2>
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => setSelectedId(asset.id)}
                className={`rounded-lg border p-3 text-left text-sm transition ${
                  asset.id === selectedId ? 'border-ink bg-ink/5' : 'border-ink/10 hover:border-ink/30'
                }`}
              >
                <p className="font-medium text-ink">{asset.title}</p>
                <p className="text-xs text-inkMuted">
                  {asset.durationSec ? `${asset.durationSec}s · ` : ''}
                  {asset.language ?? '未标注语言'}
                </p>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-4 tablet:col-span-2">
            {selected && (
              <AudioPlayer asset={selected} />
            )}

            {selectedTranscripts.length > 0 && (
              <div className="rounded-xl border border-ink/10 p-4">
                <h3 className="mb-2 text-sm font-medium text-ink">转写</h3>
                {selectedTranscripts.map((transcript) => (
                  <div key={transcript.id} className="mb-2 rounded-lg bg-ink/5 p-3">
                    <p className="mb-1 text-xs text-inkMuted">
                      {transcript.kind === 'MACHINE' ? '机器转写' : transcript.kind === 'REVISED' ? '用户修订' : '手动转写'}
                      {transcript.confidence ? ` · 置信度 ${transcript.confidence}` : ''}
                    </p>
                    {transcript.segments.map((segment) => (
                      <p key={segment.seq} className="text-sm leading-6 text-ink">
                        <span className="text-inkMuted">[{segment.startMs != null ? Math.round(segment.startMs / 1000) : '?'}s] </span>
                        {segment.text}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-ink/10 p-4">
              <h3 className="mb-2 text-sm font-medium text-ink">练习</h3>
              {relatedExercises.length === 0 ? (
                <p className="text-sm text-inkMuted">该音源还没有练习。</p>
              ) : (
                <ExerciseList exercises={relatedExercises} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 播放器：播放/暂停、速度 0.75/1/1.25、A-B 循环。 */
function AudioPlayer({ asset }: { asset: AudioAssetDto }) {
  const [rate, setRate] = useState(1);
  const [abLoop, setAbLoop] = useState<{ a: number; b: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingPointRef = useRef<'a' | 'b' | null>(null);

  const markLoop = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (pendingPointRef.current === 'a') {
      setAbLoop({ a: audio.currentTime, b: abLoop?.b ?? audio.duration });
      pendingPointRef.current = null;
    } else {
      pendingPointRef.current = 'a';
    }
  };

  return (
    <div className="rounded-xl border border-ink/10 p-4">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-ink/10 px-2.5 py-1 text-xs"
          onClick={() => {
            const audio = audioRef.current;
            if (!audio) return;
            if (audio.paused) void audio.play();
            else audio.pause();
          }}
        >
          播放/暂停
        </button>
        {[0.75, 1, 1.25].map((value) => (
          <button
            key={value}
            type="button"
            className={`rounded-lg border px-2 py-1 text-xs ${
              rate === value ? 'border-ink bg-ink/5' : 'border-ink/10'
            }`}
            onClick={() => {
              setRate(value);
              if (audioRef.current) audioRef.current.playbackRate = value;
            }}
          >
            {value}x
          </button>
        ))}
        <button
          type="button"
          className={`rounded-lg border px-2 py-1 text-xs ${
            pendingPointRef.current === 'a' ? 'border-ink bg-ink/5' : 'border-ink/10'
          }`}
          onClick={markLoop}
        >
          A-B 循环{abLoop ? '（已设）' : ''}
        </button>
        {abLoop && (
          <button
            type="button"
            className="rounded-lg border border-ink/10 px-2 py-1 text-xs"
            onClick={() => setAbLoop(null)}
          >
            取消循环
          </button>
        )}
      </div>
      <audio
        ref={audioRef}
        src={`/api/audio/${asset.id}`}
        controls
        className="w-full"
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (abLoop && audio.currentTime >= abLoop.b) audio.currentTime = abLoop.a;
        }}
      />
      <p className="mt-1 text-xs text-inkMuted">A-B 循环：先点「A-B 循环」设起点，再点一次设终点。</p>
    </div>
  );
}

function ExerciseList({ exercises }: { exercises: ListeningExerciseDto[] }) {
  return (
    <div className="flex flex-col gap-3">
      {exercises.map((exercise) => (
        <div key={exercise.id} className="rounded-lg border border-ink/10 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-medium text-ink">{exercise.title}</p>
            <span className="rounded bg-ink/5 px-2 py-0.5 text-xs text-inkMuted">
              {LISTENING_MODE_LABELS_ZH[exercise.mode as ListeningMode] ?? exercise.mode}
            </span>
          </div>
          {exercise.prompt && <p className="text-sm text-inkMuted">{exercise.prompt}</p>}
          {exercise.attempts.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              {exercise.attempts.map((attempt) => (
                <div key={attempt.id} className="text-xs text-inkMuted">
                  <span>重播 {attempt.replayCount} 次</span>
                  {attempt.firstListenResult && (
                    <span className="ml-2">首听：{attempt.firstListenResult.slice(0, 40)}…</span>
                  )}
                  {attempt.errors.length > 0 && (
                    <span className="ml-2 text-egRed">{attempt.errors.length} 处标记</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-inkMuted">尚未作答</p>
          )}
        </div>
      ))}
    </div>
  );
}
