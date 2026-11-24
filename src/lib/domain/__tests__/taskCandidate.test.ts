/**
 * 候选身份键与去重（T03）。
 *
 * 两个 bug 都是"看起来能跑、事后无法解释"的类型：
 * - `estMinutes` 进身份 → 用户把材料任务从 15 改 20 分钟，历史里同一件事变成两条；
 * - 去重按身份分组 → `REVIEW` 与 `PROBE` 永远合不起来，缺口被排两遍。
 *
 * 反过来，合并过头也会出事（`QUESTION` 两条不同来源被合成一条），所以下面
 * 同时钉「该合的合」与「不该合的不合」。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SOURCE_KINDS,
  CANDIDATE_SOURCE_PRIORITY,
  candidateKeyOf,
  dedupeCandidates,
  dedupeGroupOf,
  evaluatePrerequisites,
  gapKeyOf,
  sourceRefOf,
  type TaskCandidateDraft,
} from '../taskCandidate';
import {
  CANDIDATE_DEFAULT_MINUTES,
  CANDIDATE_FALLBACK_MINUTES,
  LISTENING_MODES,
  MATERIAL_EXERCISE_TYPES,
  SPEAKING_TASK_TYPES,
} from '../../constants';
import { DIAG_TASK_TYPES } from '@/lib/diagnostic/constants';

function draft(over: Partial<TaskCandidateDraft> = {}): TaskCandidateDraft {
  const base: TaskCandidateDraft = {
    candidateKey: '',
    sourceKind: 'REVIEW',
    sourceRef: 'r1',
    module: 'READING',
    targetSkill: 'READING',
    primarySkill: 'READING',
    track: 'IELTS_PREPARATION',
    skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'detail_scanning'),
    title: '复习：阅读细节题',
    estMinutes: 10,
    minMinutes: 5,
    maxBlockMinutes: null,
    prerequisites: [],
    validationStatus: 'RUBRIC',
    difficultyScore: null,
    isAiSuggested: false,
    aiCallLogId: null,
    expectedOutput: null,
    meta: { estMinutesSource: 'SOURCE' },
    ...over,
  };
  return { ...base, candidateKey: over.candidateKey ?? candidateKeyOf(base) };
}

describe('candidateKeyOf：身份不含时长', () => {
  it('改 estMinutes → key 不变（载荷不是身份）', () => {
    const a = draft({ estMinutes: 10 });
    const b = draft({ estMinutes: 20 });
    expect(a.candidateKey).toBe(b.candidateKey);
  });

  it('改 sourceRef → key 变', () => {
    expect(draft({ sourceRef: 'r1' }).candidateKey).not.toBe(draft({ sourceRef: 'r2' }).candidateKey);
  });

  it('改 module → key 变', () => {
    expect(draft({ module: 'READING' }).candidateKey).not.toBe(draft({ module: 'WRITING' }).candidateKey);
  });

  it('sourceRef 为 null 用 none 占位，key 形状稳定', () => {
    expect(draft({ sourceRef: null }).candidateKey).toBe('REVIEW:none:READING');
  });
});

describe('dedupeGroupOf：证据类按维度、其它按身份', () => {
  it('REVIEW / RETEST / PROBE 同维度 → 同一组（否则永远合不起来）', () => {
    const group = draft({ sourceKind: 'REVIEW' });
    const retest = draft({ sourceKind: 'RETEST', sourceRef: 'rr1' });
    const probe = draft({ sourceKind: 'PROBE', sourceRef: 'probe:READING|detail_scanning' });
    expect(dedupeGroupOf(group)).toBe(dedupeGroupOf(retest));
    expect(dedupeGroupOf(group)).toBe(dedupeGroupOf(probe));
  });

  it('不同维度 → 不同组', () => {
    const a = draft({ skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'detail_scanning') });
    const b = draft({ skillGapKey: gapKeyOf('OFFICIAL', 'READING', 'gist') });
    expect(dedupeGroupOf(a)).not.toBe(dedupeGroupOf(b));
  });

  it('QUESTION / LAB / EGIU 各自成组（不跨来源合并）', () => {
    const q1 = draft({ sourceKind: 'QUESTION', sourceRef: 'q1' });
    const q2 = draft({ sourceKind: 'QUESTION', sourceRef: 'q2' });
    expect(dedupeGroupOf(q1)).not.toBe(dedupeGroupOf(q2));
    expect(dedupeGroupOf(q1)).toBe(q1.candidateKey);
  });

  it('MATERIAL / VOCAB 的分组键**逐字**等于 `sourceRef`（不许再加一次前缀）', () => {
    // 这两条以前没有任何断言钉住返回值，于是 `material:${sourceRef}` 写出了
    // `material:material:<id>` —— 功能上仍唯一，但那个字符串会进 `dropped[].why`
    // 渲染给用户（"与 … 是同一件事（material:material:xyz）"）。
    // 文案级缺陷只能靠**字面量**断言抓：`not.toBe(candidateKey)` 之类的写法看不见它。
    const material = draft({ sourceKind: 'MATERIAL', sourceRef: 'material:m-1' });
    expect(dedupeGroupOf(material)).toBe('material:m-1');
    const vocab = draft({ sourceKind: 'VOCAB', sourceRef: 'vocab:v-1' });
    expect(dedupeGroupOf(vocab)).toBe('vocab:v-1');
  });

  it('MATERIAL / VOCAB 没有 sourceRef 时回落 `candidateKey`（各走各的）', () => {
    const material = draft({ sourceKind: 'MATERIAL', sourceRef: null });
    expect(dedupeGroupOf(material)).toBe(material.candidateKey);
  });
});

describe('dedupeCandidates：该合的合，不该合的不合', () => {
  it('REVIEW + PROBE 同维度 → 保留 REVIEW，dropped 写清被谁合并', () => {
    const review = draft({ sourceKind: 'REVIEW', title: '复习：阅读细节题' });
    const probe = draft({
      sourceKind: 'PROBE',
      sourceRef: 'probe:READING|detail_scanning',
      title: '补测：阅读细节题',
    });
    const result = dedupeCandidates([probe, review]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].sourceKind).toBe('REVIEW');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].sourceKind).toBe('PROBE');
    expect(result.dropped[0].why).toContain('REVIEW');
    expect(result.dropped[0].why).toContain('保留优先级更高');
  });

  it('5 条 REVIEW、skillGapKey 全为 null → 全部保留（不许回落成粗组）', () => {
    const reviews = Array.from({ length: 5 }, (_, index) =>
      draft({
        sourceKind: 'REVIEW',
        sourceRef: `review-${index}`,
        skillGapKey: null,
        title: `复习 ${index}`,
      }),
    );
    const result = dedupeCandidates(reviews);
    expect(result.kept, '粗组会把 5 条合成 1 条，用户少看到 4 条').toHaveLength(5);
    expect(result.dropped).toHaveLength(0);
  });

  it('2 条 RETEST 同缺口不同父证据 → 两件活，两条都保留（平级不互吞）', () => {
    const retests = [
      draft({ sourceKind: 'RETEST', sourceRef: 'retest-a', title: '复测 A' }),
      draft({ sourceKind: 'RETEST', sourceRef: 'retest-b', title: '复测 B' }),
    ];
    const result = dedupeCandidates(retests);
    expect(result.kept, '并列时保留先到的 = 静默丢数据').toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('两条 QUESTION 同 module 不同 sourceRef → 不合并', () => {
    const a = draft({ sourceKind: 'QUESTION', sourceRef: 'q1', title: '题 1' });
    const b = draft({ sourceKind: 'QUESTION', sourceRef: 'q2', title: '题 2' });
    const result = dedupeCandidates([a, b]);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('输出顺序确定性：按输入首次出现的组顺序', () => {
    const probe = draft({ sourceKind: 'PROBE', sourceRef: 'p1' });
    const vocab = draft({ sourceKind: 'VOCAB', sourceRef: 'v1', skillGapKey: null });
    const result = dedupeCandidates([probe, vocab]);
    expect(result.kept.map((row) => row.sourceKind)).toEqual(['PROBE', 'VOCAB']);
  });
});

describe('8 源全覆盖与两张分钟表', () => {
  it('CANDIDATE_SOURCE_KINDS 恰好 8 个且与优先级表一一对应', () => {
    expect(CANDIDATE_SOURCE_KINDS).toHaveLength(8);
    expect(Object.keys(CANDIDATE_SOURCE_PRIORITY).sort()).toEqual(
      [...CANDIDATE_SOURCE_KINDS].sort(),
    );
  });

  it('「本来就没有时长」的三个来源在 DEFAULT 表里，其余五个在 FALLBACK 表里', () => {
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES).sort()).toEqual(['LAB', 'PROBE', 'QUESTION']);
    expect(Object.keys(CANDIDATE_FALLBACK_MINUTES).sort()).toEqual([
      'EGIU',
      'MATERIAL',
      'RETEST',
      'REVIEW',
      'VOCAB',
    ]);
    // 两张表不许有交集：一个来源只能属于"本来没有"或"本该有却没有"
    const overlap = Object.keys(CANDIDATE_DEFAULT_MINUTES).filter((key) =>
      Object.keys(CANDIDATE_FALLBACK_MINUTES).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('两张表的键集合必须**互补**：并集 = 8 个来源、交集为空', () => {
    const derivedOnly = Object.keys(CANDIDATE_DEFAULT_MINUTES).sort();
    const withField = Object.keys(CANDIDATE_FALLBACK_MINUTES).sort();
    expect([...derivedOnly, ...withField].sort()).toEqual([...CANDIDATE_SOURCE_KINDS].sort());
  });

  it('PROBE 是 10 分钟（不是 15）', () => {
    expect(CANDIDATE_DEFAULT_MINUTES.PROBE).toBe(10);
  });

  it('QUESTION 不可拍平：开放题 15 / 简答 6 / 单选 3 各不相同', () => {
    const table = CANDIDATE_DEFAULT_MINUTES.QUESTION;
    expect(table.OPEN_TASK).toBe(15);
    expect(table.SHORT_ANSWER).toBe(6);
    expect(table.MCQ).toBe(3);
    // 拍平成一个数会同时毁掉两端：开放题少算 5 分钟、单选多算 12 分钟
    expect(new Set(Object.values(table)).size).toBeGreaterThan(1);
  });

  it('QUESTION 的键 = 诊断域 ∪ 材料域（共 8 个），LAB = 听力 ∪ 口语（共 17 个）', () => {
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.QUESTION)).toHaveLength(
      new Set([...DIAG_TASK_TYPES, ...MATERIAL_EXERCISE_TYPES]).size,
    );
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB)).toHaveLength(
      new Set([...LISTENING_MODES, ...SPEAKING_TASK_TYPES]).size,
    );
    expect(Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB)).toHaveLength(17);
  });
});

describe('映射表的键集合必须由枚举钉死（NaN 防线）', () => {
  it('QUESTION 表覆盖诊断域与材料域的**每一个**枚举值', () => {
    for (const taskType of [...DIAG_TASK_TYPES, ...MATERIAL_EXERCISE_TYPES]) {
      // 缺键 → 采集时 undefined → estMinutes NaN → 装箱 Σ 变 NaN → 任务全被挤出
      // 且**不报错**，所以只能靠这条断言在测试期拦住
      expect(
        CANDIDATE_DEFAULT_MINUTES.QUESTION[taskType as 'MCQ'],
        `taskType=${taskType} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
  });

  it('LAB 表覆盖 LISTENING_MODES 与 SPEAKING_TASK_TYPES 的每一个枚举值', () => {
    for (const mode of LISTENING_MODES) {
      expect(
        CANDIDATE_DEFAULT_MINUTES.LAB[mode as 'BLIND'],
        `听力 mode=${mode} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
    for (const taskType of SPEAKING_TASK_TYPES) {
      expect(
        CANDIDATE_DEFAULT_MINUTES.LAB[taskType as 'READ_ALOUD'],
        `口语 taskType=${taskType} 在派生表里缺键`,
      ).toBeGreaterThan(0);
    }
  });

  it('LAB 表里没有枚举外的死配置（表里有、枚举没有 → 永远用不上）', () => {
    const known = new Set<string>([...LISTENING_MODES, ...SPEAKING_TASK_TYPES]);
    const extra = Object.keys(CANDIDATE_DEFAULT_MINUTES.LAB).filter((key) => !known.has(key));
    expect(extra, `派生表里有枚举外的键：${extra.join(', ')}`).toEqual([]);
  });
});

describe('evaluatePrerequisites', () => {
  const ctx = {
    stageCode: 'S2_A2_B1' as const,
    stageOrder: { S0_PREP: 0, S1_A0_A2: 1, S2_A2_B1: 2, S3_B1_IELTS: 3 },
    readyMaterialIds: new Set(['m1']),
    approvedExerciseIds: new Set<string>(),
    confirmedTranscriptAssetIds: new Set<string>(),
    completedLessonIds: new Set(['l1']),
    evidenceIds: new Set(['e1']),
  };

  it('满足全部前置 → ready', () => {
    const result = evaluatePrerequisites(
      [
        { kind: 'STAGE_AT_LEAST', code: 'S1_A0_A2' },
        { kind: 'MATERIAL_READY', materialId: 'm1' },
        { kind: 'UNIT_ORDER', lessonId: 'l2', requiresLessonId: 'l1' },
      ],
      ctx,
    );
    expect(result.ready).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it('阶段不够 / 练习未审核 → 未满足项逐条返回（不是只返回第一个）', () => {
    const result = evaluatePrerequisites(
      [
        { kind: 'STAGE_AT_LEAST', code: 'S3_B1_IELTS' },
        { kind: 'EXERCISE_APPROVED', exerciseId: 'ex1' },
      ],
      ctx,
    );
    expect(result.ready).toBe(false);
    expect(result.unmet).toHaveLength(2);
  });
});

describe('sourceRefOf：身份字段的格式只允许一处定义', () => {
  it('8 个来源各有稳定前缀', () => {
    expect(sourceRefOf('REVIEW', 'r1')).toBe('review:r1');
    expect(sourceRefOf('RETEST', 'rt1')).toBe('retest:rt1');
    expect(sourceRefOf('PROBE', 'READING', 'detail_scanning')).toBe(
      'probe:READING|detail_scanning',
    );
    expect(sourceRefOf('VOCAB', 'a1')).toBe('vocab:a1');
    expect(sourceRefOf('MATERIAL', 'm1')).toBe('material:m1');
    expect(sourceRefOf('QUESTION', 'q1', 'diagnostic')).toBe('diagnostic:q1');
    expect(sourceRefOf('QUESTION', 'q2', 'material_exercise')).toBe('material_exercise:q2');
    expect(sourceRefOf('LAB', 'l1', 'listening')).toBe('listening:l1');
    expect(sourceRefOf('LAB', 's1', 'speaking')).toBe('speaking:s1');
    expect(sourceRefOf('EGIU', 'e1')).toBe('egiu:e1');
  });

  it('每个来源的前缀与契约一一对应，且两次调用结果相同', () => {
    // 契约表（与实现里的 SOURCE_REF_PREFIX 独立写一遍：两边都对才算数）
    const expectedPrefix: Record<(typeof CANDIDATE_SOURCE_KINDS)[number], string> = {
      REVIEW: 'review',
      RETEST: 'retest',
      PROBE: 'probe',
      VOCAB: 'vocab',
      MATERIAL: 'material',
      QUESTION: 'diagnostic',
      LAB: 'listening',
      EGIU: 'egiu',
    };
    /** 按来源补齐必填的链路信息（QUESTION/LAB/PROBE 的 extra 是必填的）。 */
    const refOf = (kind: (typeof CANDIDATE_SOURCE_KINDS)[number]): string => {
      if (kind === 'PROBE') return sourceRefOf(kind, 'x', 'sub');
      if (kind === 'QUESTION') return sourceRefOf(kind, 'x', 'diagnostic');
      if (kind === 'LAB') return sourceRefOf(kind, 'x', 'listening');
      return sourceRefOf(kind, 'x');
    };
    for (const kind of CANDIDATE_SOURCE_KINDS) {
      const ref = refOf(kind);
      expect(ref, kind).toBe(refOf(kind));
      expect(ref.split(':')[0], kind).toBe(expectedPrefix[kind]);
    }
  });

  it('不带链路信息 → 编译期失败（QUESTION / LAB / PROBE 的 extra 是必填的）', () => {
    // 下面三条编译期指令是**断言**：如果哪天有人把 extra 改回可选，
    // 指令本身就会报"未使用"（TS2578），`typecheck:test` 立刻红。
    // 静默回落成诊断链路，正是"两条链路混成一条"的入口 —— 混了之后 candidateKey 会撞、
    // dedupeGroup 会合，且都不报错。
    //
    // 但它只守「守卫被放松」，守不住「守卫被删除」——把整行删掉既没有指令也没有断言，
    // `typecheck:test` 照样绿。数量兜底见文件末尾 `编译期指令的数量守门`。
    // （本段刻意不写出 `@` 开头的字面量，否则数量统计会被注释误算一条。）
    // @ts-expect-error QUESTION 缺 chain
    const missingQuestionChain = () => sourceRefOf('QUESTION', 'x');
    // @ts-expect-error LAB 缺 chain
    const missingLabChain = () => sourceRefOf('LAB', 'x');
    // @ts-expect-error PROBE 缺 subskill
    const missingProbeSubskill = () => sourceRefOf('PROBE', 'READING');
    void missingQuestionChain;
    void missingLabChain;
    void missingProbeSubskill;
  });

  it('LAB 的两条链路前缀互不相等；QUESTION 的两条链路前缀互不相等', () => {
    expect(sourceRefOf('LAB', '1', 'listening')).not.toBe(sourceRefOf('LAB', '1', 'speaking'));
    expect(sourceRefOf('QUESTION', '1', 'diagnostic')).not.toBe(
      sourceRefOf('QUESTION', '1', 'material_exercise'),
    );
  });

  it('sourceRef 变则 candidateKey 变（身份由它构成）', () => {
    const a = draft({ sourceKind: 'LAB', sourceRef: sourceRefOf('LAB', '1', 'listening') });
    const b = draft({ sourceKind: 'LAB', sourceRef: sourceRefOf('LAB', '1', 'speaking') });
    expect(a.candidateKey).not.toBe(b.candidateKey);
  });
});

/**
 * 编译期指令的数量守门。
 *
 * 上一段那三条指令**只守「守卫被放松」，守不住「守卫被删除」**：
 * 把整行连注释带调用一起删掉，既没有指令也没有断言，`typecheck:test` 照样绿 ——
 * 而"少了一条链路必填约束"正是它们守着的那件事。
 *
 * 所以这里数一遍。注意**只数指令行**（行首可缩进 + `//` 直接跟指令关键字），
 * 不数正文里的提及：一旦全文统计，正文里迟早会写这个词（本文就在讨论它），
 * 于是"删掉一条指令 + 顺手多写一句说明"两件事一起做，计数还是对得上，守门静默失效。
 * （本段刻意不写出带 `@` 的完整字面量：那会被 scanner 当成一条未使用的指令。）
 *
 * 这个上限同时管住另一种用法：有人为了压掉**真错误**而顺手多写几条指令。
 */
describe('编译期指令的数量守门（防删除 / 防滥用）', () => {
  const source = readFileSync(new URL('./taskCandidate.test.ts', import.meta.url), 'utf8');
  const lines = source.split('\n');
  /** 只有「行首（允许缩进）是 `//` 且紧跟指令关键字」的行才是真指令。 */
  const directiveLines = lines
    .map((line, at) => (/^[ \t]*\/\/[ \t]*@ts-expect-error/.test(line) ? at : -1))
    .filter((at) => at >= 0);

  it('QUESTION / LAB / PROBE 三条链路必填约束的指令不多不少', () => {
    expect(directiveLines).toHaveLength(3);
  });

  it('每条指令的下一行都真的是 sourceRefOf 调用（防止指令被挪到别的语句上）', () => {
    // 先证集合非空（`41 §1.9` A-1）：`[]` 会让下面的循环空转，这条测试静默变绿。
    expect(directiveLines.length).toBeGreaterThan(0);
    for (const at of directiveLines) {
      // TS 只要求"下一条语句报错"，不要求"报的错是我们想守的那个"：
      // 指令被挪到一条无关的语句上，约束丢了而指令还在，编译仍然绿。
      expect(lines[at + 1] ?? '', `第 ${at + 1} 行`).toContain('sourceRefOf(');
    }
  });
});
