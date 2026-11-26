'use client';

/**
 * 单词表单（T26）。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createVocabWordAction, updateVocabWordAction } from '@/lib/actions/vocab';
import { MASTERY_LABEL_ZH, MASTERY_LEVELS, VOCAB_SOURCES } from '@/lib/constants';
import { useBusinessToday } from '@/components/layout/BusinessTimeProvider';
import type { MasteryLevel, VocabWordRowDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormField, inputClass, textareaClass } from '@/components/ui/FormField';

export function VocabForm({
  editing,
  onToast,
  onDone,
}: {
  editing: VocabWordRowDto | null;
  onToast: (message: string, tone: 'success' | 'error') => void;
  onDone: () => void;
}) {
  const businessDate = useBusinessToday();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [word, setWord] = useState(editing?.word ?? '');
  const [phonetic, setPhonetic] = useState(editing?.phonetic ?? '');
  const [partOfSpeech, setPartOfSpeech] = useState(editing?.partOfSpeech ?? '');
  const [meaningZh, setMeaningZh] = useState(editing?.meaningZh ?? '');
  const [meaningEn, setMeaningEn] = useState(editing?.meaningEn ?? '');
  const [collocation, setCollocation] = useState(editing?.collocation ?? '');
  const [exampleSentence, setExampleSentence] = useState(editing?.exampleSentence ?? '');
  const [source, setSource] = useState(editing?.source ?? VOCAB_SOURCES[1]);
  const [learnedDate, setLearnedDate] = useState(editing?.learnedDate ?? businessDate);
  const [mastery, setMastery] = useState<MasteryLevel>(editing?.mastery ?? 'RECOGNIZE_ONLY');

  const submit = () => {
    setFieldErrors({});
    startTransition(async () => {
      const payload = {
        id: editing?.id,
        word,
        phonetic: phonetic || undefined,
        partOfSpeech: partOfSpeech || undefined,
        meaningZh,
        meaningEn: meaningEn || undefined,
        collocation: collocation || undefined,
        exampleSentence: exampleSentence || undefined,
        source,
        learnedDate,
        mastery,
      };
      const result = editing
        ? await updateVocabWordAction(payload)
        : await createVocabWordAction(payload);

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        onToast(result.error, 'error');
        return;
      }
      onToast(editing ? '单词已更新' : '单词已加入词汇表', 'success');
      onDone();
      router.refresh();
    });
  };

  return (
    <Card title={editing ? `编辑单词：${editing.word}` : '新增单词'} description="三档掌握度不要凑数：能主动造句才算「能主动使用」">
      <div className="grid gap-2 mobile:grid-cols-2 md:grid-cols-3">
        <FormField label="单词" htmlFor="vw-word" required error={fieldErrors.word}>
          <input
            id="vw-word"
            value={word}
            onChange={(event) => setWord(event.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label="音标" htmlFor="vw-phonetic" error={fieldErrors.phonetic}>
          <input
            id="vw-phonetic"
            value={phonetic}
            onChange={(event) => setPhonetic(event.target.value)}
            placeholder="/ˈeksəmpl/"
            className={inputClass}
          />
        </FormField>
        <FormField label="词性" htmlFor="vw-pos" error={fieldErrors.partOfSpeech}>
          <input
            id="vw-pos"
            value={partOfSpeech}
            onChange={(event) => setPartOfSpeech(event.target.value)}
            placeholder="n. / v. / adj."
            className={inputClass}
          />
        </FormField>
        <FormField label="中文释义" htmlFor="vw-zh" required error={fieldErrors.meaningZh}>
          <input
            id="vw-zh"
            value={meaningZh}
            onChange={(event) => setMeaningZh(event.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label="英文释义" htmlFor="vw-en" error={fieldErrors.meaningEn}>
          <input
            id="vw-en"
            value={meaningEn}
            onChange={(event) => setMeaningEn(event.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label="常用搭配" htmlFor="vw-coll" error={fieldErrors.collocation}>
          <input
            id="vw-coll"
            value={collocation}
            onChange={(event) => setCollocation(event.target.value)}
            placeholder="例如 make a decision"
            className={inputClass}
          />
        </FormField>
        <FormField label="学习日" htmlFor="vw-date" required error={fieldErrors.learnedDate}>
          <input
            id="vw-date"
            type="date"
            value={learnedDate}
            onChange={(event) => setLearnedDate(event.target.value)}
            className={inputClass}
          />
        </FormField>
        <FormField label="来源" htmlFor="vw-source" error={fieldErrors.source}>
          <select
            id="vw-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className={inputClass}
          >
            {VOCAB_SOURCES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="掌握度" htmlFor="vw-mastery" error={fieldErrors.mastery}>
          <select
            id="vw-mastery"
            value={mastery}
            onChange={(event) => setMastery(event.target.value as MasteryLevel)}
            className={inputClass}
          >
            {MASTERY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {MASTERY_LABEL_ZH[level]}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="mt-2">
        <FormField label="例句" htmlFor="vw-example" error={fieldErrors.exampleSentence}>
          <textarea
            id="vw-example"
            value={exampleSentence}
            onChange={(event) => setExampleSentence(event.target.value)}
            className={textareaClass}
            placeholder="用这个词造一句自己的话，比抄词典例句更有用"
          />
        </FormField>
      </div>

      <div className="mt-3 flex gap-1.5">
        <Button variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? '保存中…' : editing ? '保存修改' : '加入词汇表'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
      </div>
    </Card>
  );
}
