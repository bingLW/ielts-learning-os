import { describe, expect, it } from 'vitest';
import { defaultTaskEstimate } from '@/lib/domain/taskEstimate';
import { candidateKeyOf, sourceRefOf } from '@/lib/domain/taskCandidate';
import {
  buildDiagnosticProposalCandidates,
  diagnosticProposalFingerprint,
  parseDiagnosticProposalTasksJson,
  proposalWindowForHorizon,
  type BuildDiagnosticProposalCandidatesArgs,
} from '../planProposal';

const AS_OF_DATE = '2026-11-27';
const EXPECTED_OUTPUT = '完成任务并记录可检查产出（答案、录音、文字或练习结果）';

function task(skill: string, overrides: Record<string, unknown> = {}) {
  return {
    title: `诊断任务：${skill}`,
    minutes: 25,
    skill,
    evidenceRef: `SkillProfile:${skill}`,
    reason: `补齐 ${skill} 的证据与训练产出`,
    ...overrides,
  };
}

function phase(
  window: '7D' | '30D' | '90D',
  tasks: ReturnType<typeof task>[],
  focus = '诊断训练阶段',
) {
  return { window, focus, tasks };
}

function tasksJson(...phases: Array<ReturnType<typeof phase> & { budget?: unknown }>): string {
  return JSON.stringify(phases);
}

function args(overrides: Partial<BuildDiagnosticProposalCandidatesArgs> = {}): BuildDiagnosticProposalCandidatesArgs {
  return {
    proposalId: 'proposal-1',
    reportId: 'report-1',
    asOfDate: AS_OF_DATE,
    horizonDays: 7,
    minTaskMinutes: 5,
    tasks: tasksJson(
      phase('7D', [task('LISTENING')]),
      phase('30D', [task('READING')]),
      phase('90D', [task('META')]),
    ),
    ...overrides,
  };
}

describe('parseDiagnosticProposalTasksJson', () => {
  it('接受初始 PlanPhase 的 budget 摘要，也接受用户编辑后无 budget 的形状', () => {
    const generated = tasksJson({
      ...phase('7D', [task('LISTENING')]),
      budget: {
        window: '7D',
        startDate: AS_OF_DATE,
        endDate: '2026-12-03',
        days: 7,
        totalMinutes: 175,
        dailyAverage: 25,
        source: 'USER',
      },
    });

    expect(parseDiagnosticProposalTasksJson(generated)).toEqual({
      ok: true,
      data: [{
        window: '7D',
        focus: '诊断训练阶段',
        tasks: [task('LISTENING')],
        budget: expect.any(Object),
      }],
    });
    expect(parseDiagnosticProposalTasksJson(tasksJson(phase('7D', [task('READING')])))).toEqual({
      ok: true,
      data: [phase('7D', [task('READING')])],
    });
  });

  it.each(['{', '', 'null', '{}', '[null]', '[{"window":"7D"}]'])(
    '拒绝非法 JSON 或阶段形状：%s',
    (raw) => {
      const result = parseDiagnosticProposalTasksJson(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION');
    },
  );

  it('拒绝重复窗口、超过阶段/任务数量上限和未知字段', () => {
    const duplicates = tasksJson(phase('7D', []), phase('7D', []));
    const tooManyPhases = tasksJson(phase('7D', []), phase('7D', []), phase('30D', []), phase('90D', []));
    const tooManyTasks = tasksJson(phase('7D', Array.from({ length: 9 }, () => task('READING'))));
    const unknownTaskField = tasksJson(phase('7D', [task('READING', { unexpected: true })]));

    for (const raw of [duplicates, tooManyPhases, tooManyTasks, unknownTaskField]) {
      expect(parseDiagnosticProposalTasksJson(raw).ok).toBe(false);
    }
  });

  it.each([
    ['title', ''],
    ['title', 'x'.repeat(121)],
    ['reason', 'x'.repeat(401)],
    ['evidenceRef', 'x'.repeat(201)],
    ['skill', 'UNKNOWN_SKILL'],
    ['skill', ''],
    ['skill', 'x'.repeat(41)],
  ])('拒绝非法任务字段 %s', (field, value) => {
    const raw = tasksJson(phase('7D', [task('READING', { [field]: value })]));
    const result = parseDiagnosticProposalTasksJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty(`0.tasks.0.${field}`);
  });

  it('focus 按 activatePlanSchema 的 200 字上限校验', () => {
    expect(parseDiagnosticProposalTasksJson(tasksJson(phase('7D', [], 'x'.repeat(200)))).ok).toBe(true);
    expect(parseDiagnosticProposalTasksJson(tasksJson(phase('7D', [], 'x'.repeat(201)))).ok).toBe(false);
  });

  it.each([4, 241, 5.5, '20', null])('拒绝非法分钟值 %s，且不强制转换字符串', (minutes) => {
    expect(parseDiagnosticProposalTasksJson(tasksJson(phase('7D', [task('READING', { minutes })]))).ok).toBe(false);
  });

  it.each([5, 240])('接受分钟边界 %s', (minutes) => {
    const result = parseDiagnosticProposalTasksJson(tasksJson(phase('7D', [task('READING', { minutes })])));
    expect(result.ok).toBe(true);
  });
});

describe('buildDiagnosticProposalCandidates 窗口选择', () => {
  it.each([
    [1, '7D', 'LISTENING'],
    [7, '7D', 'LISTENING'],
    [30, '30D', 'READING'],
    [90, '90D', 'META'],
  ] as const)('horizonDays=%s 只归一 %s 窗口', (horizonDays, window, skill) => {
    const candidates = buildDiagnosticProposalCandidates(args({ horizonDays }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].meta.diagnosticProposal).toMatchObject({ window, order: 0 });
    expect(candidates[0].targetSkill).toBe(skill);
  });

  it.each([0, 2, 8, 29, 31, 89, 91, 1.5, Number.NaN])('拒绝不支持的 horizonDays=%s', (horizonDays) => {
    expect(() => buildDiagnosticProposalCandidates(args({ horizonDays }))).toThrow(/视野/);
  });

  it('缺少选中窗口时返回空候选，不猜测其它窗口', () => {
    expect(buildDiagnosticProposalCandidates(args({ tasks: tasksJson(phase('30D', [task('READING')])) }))).toEqual([]);
  });
});

describe('buildDiagnosticProposalCandidates 技能与载荷', () => {
  const mappings = [
    ['LISTENING', 'LISTENING', 'LISTENING', 'LISTENING'],
    ['READING', 'READING', 'READING', 'READING'],
    ['SPEAKING', 'SPEAKING', 'SPEAKING', 'SPEAKING'],
    ['WRITING', 'WRITING', 'WRITING', 'WRITING'],
    ['GRAMMAR', 'GRAMMAR', 'GRAMMAR', 'FOUNDATION'],
    ['VOCABULARY', 'VOCAB_REVIEW', 'VOCAB', 'FOUNDATION'],
    ['SENTENCE_STRUCTURE', 'SENTENCE', 'SENTENCE', 'FOUNDATION'],
    ['EMLR', 'MEDIATED', 'MEDIATED', 'FOUNDATION'],
    ['META', 'REVIEW_PLAN', 'META', 'FOUNDATION'],
  ] as const;

  it.each(mappings)('%s 显式映射到 %s / %s / %s', (skill, module, targetSkill, primarySkill) => {
    const [candidate] = buildDiagnosticProposalCandidates(args({
      tasks: tasksJson(phase('7D', [task(skill)])),
    }));
    expect(candidate).toMatchObject({ module, targetSkill, primarySkill });
    expect(candidate.track).toBe(skill === 'EMLR' ? 'ENGLISH_MEDIATED_LEARNING' : 'GENERAL_ENGLISH');
  });

  it.each(['UNKNOWN', 'READING_EXT', 'listening', '__proto__'])('未知技能 %s 明确报错且不回落 READING', (skill) => {
    expect(() => buildDiagnosticProposalCandidates(args({
      tasks: tasksJson(phase('7D', [task(skill)])),
    }))).toThrow(/诊断计划任务不合法/);
  });

  it('原样保留用户编辑的标题、分钟、理由和证据引用', () => {
    const edited = task('WRITING', {
      title: '  用户改写：书信结论段  ',
      minutes: 37,
      evidenceRef: 'EvidenceChain:用户选择-07',
      reason: '  用户理由：先解决结论句，再补连接词。  ',
    });
    const originalJson = tasksJson(phase('7D', [edited], '  用户阶段焦点  '));
    const [candidate] = buildDiagnosticProposalCandidates(args({ tasks: originalJson }));

    expect(candidate).toMatchObject({
      title: edited.title,
      estMinutes: 37,
      minMinutes: 37,
      maxBlockMinutes: 37,
      meta: {
        estMinutesSource: 'SOURCE',
        estimate: defaultTaskEstimate(37),
        diagnosticProposal: {
          proposalId: 'proposal-1',
          reportId: 'report-1',
          window: '7D',
          order: 0,
          evidenceRef: edited.evidenceRef,
          userReason: edited.reason,
        },
      },
    });
    expect(candidate.expectedOutput).toBe(EXPECTED_OUTPUT);
    expect(args({ tasks: originalJson }).tasks).toBe(originalJson);
  });

  it('设置统一 Planner 所需的候选默认字段', () => {
    const [candidate] = buildDiagnosticProposalCandidates(args());
    expect(candidate).toMatchObject({
      sourceKind: 'MATERIAL',
      skillGapKey: null,
      dueDate: null,
      prerequisites: [],
      validationStatus: 'UNVERIFIED',
      difficultyScore: null,
      isAiSuggested: false,
      aiCallLogId: null,
    });
  });

  it('小于调用方最小粒度的任务明确拒绝', () => {
    expect(() => buildDiagnosticProposalCandidates(args({
      minTaskMinutes: 30,
      tasks: tasksJson(phase('7D', [task('READING', { minutes: 25 })])),
    }))).toThrow(/低于最小粒度 30/);
  });

  it.each([
    { asOfDate: '2026-02-30' },
    { asOfDate: '' },
    { proposalId: '' },
    { reportId: '   ' },
    { minTaskMinutes: 4 },
    { minTaskMinutes: 20.5 },
  ])('拒绝非法适配参数 %j', (override) => {
    expect(() => buildDiagnosticProposalCandidates(args(override))).toThrow();
  });
});

describe('buildDiagnosticProposalCandidates 身份与顺序', () => {
  it('每个任务 sourceRef/candidateKey 唯一，order 按输入顺序从 0 保留', () => {
    const candidates = buildDiagnosticProposalCandidates(args({
      tasks: tasksJson(phase('7D', [
        task('READING', { title: '同名任务' }),
        task('READING', { title: '同名任务' }),
        task('WRITING'),
      ])),
    }));

    expect(candidates.map((candidate) => candidate.meta.diagnosticProposal?.order)).toEqual([0, 1, 2]);
    expect(candidates.map((candidate) => candidate.sourceRef)).toEqual([
      'material:proposal-1:7D:0',
      'material:proposal-1:7D:1',
      'material:proposal-1:7D:2',
    ]);
    expect(new Set(candidates.map((candidate) => candidate.sourceRef)).size).toBe(3);
    expect(new Set(candidates.map((candidate) => candidate.candidateKey)).size).toBe(3);
    for (const candidate of candidates) {
      expect(candidate.sourceRef).toBe(sourceRefOf(
        'MATERIAL',
        `proposal-1:7D:${candidate.meta.diagnosticProposal?.order}`,
      ));
      expect(candidate.candidateKey).toBe(candidateKeyOf(candidate));
    }
  });

  it('相同输入产生稳定身份，修改用户载荷不改变身份', () => {
    const base = args({ tasks: tasksJson(phase('7D', [task('READING')])) });
    const edited = args({
      tasks: tasksJson(phase('7D', [task('READING', {
        title: '改标题', minutes: 60, reason: '改理由', evidenceRef: '改证据',
      })])),
    });
    const first = buildDiagnosticProposalCandidates(base)[0];
    const repeated = buildDiagnosticProposalCandidates(base)[0];
    const changed = buildDiagnosticProposalCandidates(edited)[0];

    expect(repeated.sourceRef).toBe(first.sourceRef);
    expect(repeated.candidateKey).toBe(first.candidateKey);
    expect(changed.sourceRef).toBe(first.sourceRef);
    expect(changed.candidateKey).toBe(first.candidateKey);
    expect(changed.estMinutes).toBe(60);
  });

  it('不同 proposalId 或窗口不共享身份', () => {
    const first = buildDiagnosticProposalCandidates(args())[0];
    const otherProposal = buildDiagnosticProposalCandidates(args({ proposalId: 'proposal-2' }))[0];
    const otherWindow = buildDiagnosticProposalCandidates(args({ horizonDays: 30 }))[0];
    expect(otherProposal.sourceRef).not.toBe(first.sourceRef);
    expect(otherWindow.sourceRef).not.toBe(first.sourceRef);
  });
});

describe('diagnosticProposalFingerprint', () => {
  const input = {
    id: 'proposal-1',
    status: 'DRAFT',
    asOfDate: AS_OF_DATE,
    tasksJson: tasksJson(phase('7D', [task('READING')])),
  };

  it('SHA-256 指纹确定且为 64 位十六进制', () => {
    const first = diagnosticProposalFingerprint(input);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnosticProposalFingerprint({ ...input })).toBe(first);
  });

  it.each([
    { id: 'proposal-2' },
    { status: 'ACTIVE' },
    { asOfDate: '2026-11-28' },
    { tasksJson: tasksJson(phase('7D', [task('WRITING')])) },
    { tasksJson: `${input.tasksJson} ` },
  ])('任一字段变化都改变指纹：%j', (override) => {
    expect(diagnosticProposalFingerprint({ ...input, ...override })).not.toBe(
      diagnosticProposalFingerprint(input),
    );
  });

  it('直接映射三个窗口，不依赖候选构建', () => {
    expect(proposalWindowForHorizon(1)).toBe('7D');
    expect(proposalWindowForHorizon(7)).toBe('7D');
    expect(proposalWindowForHorizon(30)).toBe('30D');
    expect(proposalWindowForHorizon(90)).toBe('90D');
  });
});
