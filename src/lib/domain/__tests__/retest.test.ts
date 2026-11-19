import { describe, expect, it } from 'vitest';
import {
  checkRetestEvidence,
  checkTransferContext,
  retestEvidenceLevel,
  retestEvidenceType,
  retestIsDue,
  retestOverdueDays,
  sortRetestQueue,
  summarizeRetests,
} from '../retest';

describe('retestEvidenceType', () => {
  it('maps each retest stage to the lifecycle evidence type', () => {
    expect(retestEvidenceType('IMMEDIATE')).toBe('IMMEDIATE_RETEST');
    expect(retestEvidenceType('DELAYED')).toBe('DELAYED_RETEST');
    expect(retestEvidenceType('APPLIED')).toBe('APPLIED_TASK');
    expect(retestEvidenceType('TRANSFER')).toBe('TRANSFER');
  });
});

describe('retestEvidenceLevel', () => {
  it('uses Quick ≤15, Standard 16–59, Full ≥60', () => {
    expect(retestEvidenceLevel(10)).toBe('QUICK');
    expect(retestEvidenceLevel(15)).toBe('QUICK');
    expect(retestEvidenceLevel(16)).toBe('STANDARD');
    expect(retestEvidenceLevel(59)).toBe('STANDARD');
    expect(retestEvidenceLevel(60)).toBe('FULL');
  });
});

describe('retestOverdueDays / retestIsDue', () => {
  it('counts overdue days only after the due date', () => {
    expect(retestOverdueDays('2026-11-10', '2026-11-19')).toBe(9);
    expect(retestOverdueDays('2026-11-19', '2026-11-19')).toBe(0);
    expect(retestOverdueDays('2026-12-01', '2026-11-19')).toBe(0);
  });

  it('treats only PENDING schedules on/before today as due', () => {
    expect(retestIsDue({ status: 'PENDING', dueDate: '2026-11-19' }, '2026-11-19')).toBe(true);
    expect(retestIsDue({ status: 'PENDING', dueDate: '2026-11-10' }, '2026-11-19')).toBe(true);
    expect(retestIsDue({ status: 'PENDING', dueDate: '2026-11-20' }, '2026-11-19')).toBe(false);
    expect(retestIsDue({ status: 'DONE', dueDate: '2026-11-10' }, '2026-11-19')).toBe(false);
  });
});

describe('checkTransferContext', () => {
  const parent = {
    prompt: '描述你最喜欢的一个城市',
    materialSource: 'IELTS Cue Card 12',
    taskId: 'task-1',
  };

  it('rejects redoing exactly the same prompt', () => {
    const result = checkTransferContext(parent, {
      prompt: '  描述你最喜欢的一个城市 ',
      materialSource: null,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('重做原题');
  });

  it('rejects when the candidate still hangs on the same plan task', () => {
    const result = checkTransferContext(parent, {
      prompt: '在小组讨论中介绍一个城市并回答追问',
      materialSource: '课堂讨论',
      taskId: 'task-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('原计划任务');
  });

  it('rejects when no new condition is written', () => {
    const result = checkTransferContext(parent, {
      prompt: null,
      materialSource: null,
      taskId: null,
    });
    expect(result.ok).toBe(false);
  });

  it('requires a prompt when the parent has one', () => {
    const result = checkTransferContext(parent, {
      prompt: null,
      materialSource: '另一段播客',
      taskId: null,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a genuinely new prompt in a new context', () => {
    const result = checkTransferContext(parent, {
      prompt: '在 5 分钟会议中介绍方案并回应质疑',
      materialSource: '工作场景模拟',
      taskId: 'task-2',
    });
    expect(result.ok).toBe(true);
  });
});

describe('checkRetestEvidence', () => {
  const base = {
    retestType: 'DELAYED' as const,
    parentSkill: 'WRITING' as const,
    evidenceSkill: 'WRITING' as const,
    evidenceType: 'DELAYED_RETEST' as const,
    assistanceLevel: 'A0' as const,
  };

  it('accepts matching skill, lifecycle type and A0', () => {
    expect(checkRetestEvidence(base).ok).toBe(true);
  });

  it('rejects a different skill', () => {
    const result = checkRetestEvidence({ ...base, evidenceSkill: 'READING' });
    expect(result.ok).toBe(false);
  });

  it('rejects the wrong lifecycle evidence type', () => {
    const result = checkRetestEvidence({ ...base, evidenceType: 'BASELINE' });
    expect(result.ok).toBe(false);
  });

  it('rejects assisted attempts as completed retests', () => {
    const result = checkRetestEvidence({ ...base, assistanceLevel: 'A2' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('A0');
  });
});

describe('summarizeRetests', () => {
  const todayStr = '2026-11-19';

  it('buckets pending schedules into overdue / today / next7', () => {
    const stats = summarizeRetests(
      [
        { status: 'PENDING', dueDate: '2026-11-10', retestType: 'IMMEDIATE' },
        { status: 'PENDING', dueDate: '2026-11-19', retestType: 'DELAYED' },
        { status: 'PENDING', dueDate: '2026-11-24', retestType: 'APPLIED' },
        { status: 'PENDING', dueDate: '2027-02-11', retestType: 'TRANSFER' },
        { status: 'DONE', dueDate: '2026-11-01', retestType: 'IMMEDIATE' },
        { status: 'SKIPPED', dueDate: '2026-11-02', retestType: 'DELAYED' },
      ],
      todayStr,
    );
    expect(stats.pending).toBe(4);
    expect(stats.overdue).toBe(1);
    expect(stats.dueToday).toBe(1);
    expect(stats.next7).toBe(1);
    expect(stats.done).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.byType.TRANSFER).toBe(1);
  });

  it('handles an empty queue without NaN', () => {
    const stats = summarizeRetests([], todayStr);
    expect(stats.pending).toBe(0);
    expect(stats.overdue).toBe(0);
    expect(stats.done).toBe(0);
  });
});

describe('sortRetestQueue', () => {
  it('puts pending first, then orders by due date', () => {
    const sorted = sortRetestQueue([
      { status: 'DONE' as const, dueDate: '2026-11-01' },
      { status: 'PENDING' as const, dueDate: '2026-12-01' },
      { status: 'PENDING' as const, dueDate: '2026-11-10' },
    ]);
    expect(sorted.map((row) => row.dueDate)).toEqual([
      '2026-11-10',
      '2026-12-01',
      '2026-11-01',
    ]);
  });
});
