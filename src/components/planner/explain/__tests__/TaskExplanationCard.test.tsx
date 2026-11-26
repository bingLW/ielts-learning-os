import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MistakeAttribution } from '@/lib/domain/taskCandidate';
import type { PlanExplanationTaskDto } from '@/lib/queries/planner';
import { TaskExplanationCard } from '../TaskExplanationCard';

function taskWithMistake(mistake: MistakeAttribution): PlanExplanationTaskDto {
  return {
    taskId: 'task-mistake',
    module: 'META',
    moduleLabel: '错题复习',
    skill: 'META',
    priority: 'P0',
    priorityLabel: 'P0 · 优先',
    status: 'TODO',
    plannedMinutes: 5,
    actualMinutes: 0,
    sourceLabel: '到期错题',
    sourceTone: 'review',
    explanation: {
      reason: '到期错题复习',
      priority: 'P0',
      score: 0.9,
      factors: {},
      weightsVersion: 'v1',
      gapRef: null,
      estMinutes: 5,
      minMinutes: 5,
      estimate: null,
      goalRef: null,
      question: null,
      mistake,
      prerequisites: [],
      expectedOutput: '完成错题复盘',
      consequenceIfSkipped: '同类错误可能重复出现',
      origin: 'RULE',
      wordingSource: 'TEMPLATE',
    },
  };
}

describe('TaskExplanationCard MISTAKE 三态', () => {
  it('逐态区分已归属、技能未知与未归属，不把未知技能说成没有学习记录', () => {
    const attributed = renderToStaticMarkup(<TaskExplanationCard task={taskWithMistake({
      studyRecordId: 'study-record-123456', skill: 'READING', status: 'ATTRIBUTED',
    })} goalRef={null} />);
    const unknown = renderToStaticMarkup(<TaskExplanationCard task={taskWithMistake({
      studyRecordId: 'study-record-654321', skill: 'UNMAPPED_SKILL', status: 'UNKNOWN_SKILL',
    })} goalRef={null} />);
    const unattributed = renderToStaticMarkup(<TaskExplanationCard task={taskWithMistake({
      studyRecordId: null, skill: null, status: 'UNATTRIBUTED',
    })} goalRef={null} />);

    expect(attributed).toContain('错题归属：学习记录 study-reco / READING');
    expect(unknown).toContain('错题归属：学习记录已关联，但技能未知（技能归 META）');
    expect(unknown).not.toContain('错题归属：未归属学习记录');
    expect(unattributed).toContain('错题归属：未归属学习记录（技能归 META）');
    expect(unattributed).not.toContain('学习记录已关联');
  });
});
