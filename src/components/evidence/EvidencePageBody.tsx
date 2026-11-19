'use client';

/**
 * Evidence Center 页主体：证据覆盖统计 + 过滤 + 录入/派生 + 列表 + 归档确认。
 *
 * 强调口径：统计的是「证据覆盖率」，不是学习分数；独立证据占比只统计活动证据。
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveEvidenceAction } from '@/lib/actions/evidence';
import {
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
  EVIDENCE_SKILLS,
  LEARNING_EVIDENCE_TYPES,
  LEARNING_EVIDENCE_TYPE_LABEL_ZH,
} from '@/lib/constants';
import type { EvidenceStats } from '@/lib/domain/evidence';
import type {
  EvidenceDetailDto,
  EvidenceLevel,
  EvidenceSkill,
  LearningEvidenceType,
  RetestCompletionContextDto,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { selectClass } from '@/components/ui/FormField';
import { Icon } from '@/components/ui/Icon';
import { StatTile } from '@/components/ui/StatTile';
import { Toast, useToastState } from '@/components/ui/Toast';
import { EvidenceForm } from './EvidenceForm';
import { EvidenceList } from './EvidenceList';

export interface EvidencePageBodyProps {
  rows: EvidenceDetailDto[];
  stats: EvidenceStats;
  /** 从 /retest 完成复测时带入；有值时表单直接打开并锁定阶段。 */
  retestContext?: RetestCompletionContextDto | null;
}

export function EvidencePageBody({ rows, stats, retestContext = null }: EvidencePageBodyProps) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [pending, startTransition] = useTransition();

  const [formOpen, setFormOpen] = useState(Boolean(retestContext));
  const [parent, setParent] = useState<EvidenceDetailDto | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<EvidenceDetailDto | null>(null);

  const [skillFilter, setSkillFilter] = useState<EvidenceSkill | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<LearningEvidenceType | 'ALL'>('ALL');
  const [levelFilter, setLevelFilter] = useState<EvidenceLevel | 'ALL'>('ALL');
  const [includeArchived, setIncludeArchived] = useState(false);

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (!includeArchived && row.archivedAt !== null) return false;
        if (skillFilter !== 'ALL' && row.skill !== skillFilter) return false;
        if (typeFilter !== 'ALL' && row.evidenceType !== typeFilter) return false;
        if (levelFilter !== 'ALL' && row.level !== levelFilter) return false;
        return true;
      }),
    [rows, includeArchived, skillFilter, typeFilter, levelFilter],
  );

  const archivedCount = rows.length - stats.active;

  const openCreate = () => {
    setParent(null);
    setFormOpen(true);
  };

  const openDerive = (row: EvidenceDetailDto) => {
    setParent(row);
    setFormOpen(true);
  };

  const confirmArchive = () => {
    if (!archiveTarget) return;
    const target = archiveTarget;
    startTransition(async () => {
      const result = await archiveEvidenceAction({ id: target.id });
      setArchiveTarget(null);
      if (!result.ok) {
        show(result.error, 'error');
        return;
      }
      show('证据已归档（版本链与附件保留，可勾选「含归档」查看）', 'success');
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">Evidence Center</h1>
          <p className="text-xs text-inkMuted">
            基线 → 辅助 → 即时复测 → 延迟复测 → 实际应用 → 迁移验证 · 学习时长和播放次数不算能力证据
          </p>
        </div>
        {!formOpen && (
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Icon name="plus" size={13} />
            录入证据
          </Button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="活动证据"
          value={stats.active}
          unit="条"
          tone="neutral"
          hint={`共 ${stats.total} 条，其中归档 ${archivedCount} 条`}
          scopeNote="已完成保存、未归档的证据记录数"
        />
        <StatTile
          label="独立证据占比"
          value={stats.independentRate === null ? '—' : `${Math.round(stats.independentRate * 100)}%`}
          tone="output"
          hint={stats.independentRate === null ? '暂无活动证据，不补 0' : `${stats.independent} / ${stats.active} 条为 A0`}
          scopeNote="只统计 A0 无辅助；A1–A4 不计独立"
        />
        <StatTile
          label="核心链完整"
          value={stats.chainSkills.length}
          unit="项技能"
          tone="mastery"
          hint={
            stats.chainSkills.length > 0
              ? stats.chainSkills.map((item) => EVIDENCE_SKILL_LABEL_ZH[item]).join('、')
              : '需基线+辅助+即时复测+延迟复测'
          }
          scopeNote="E0–E3 齐全才算核心链完整，不代表已达到 CEFR 等级"
        />
        <StatTile
          label="待补迁移"
          value={
            stats.chainSkills.filter((item) => {
              const chain = rows.filter(
                (row) =>
                  row.skill === item &&
                  row.archivedAt === null &&
                  (row.evidenceType === 'APPLIED_TASK' || row.evidenceType === 'TRANSFER'),
              );
              return chain.length === 0;
            }).length
          }
          unit="项技能"
          tone="plan"
          hint="核心链完整但还没有 E4/E5 的证据"
          scopeNote="约 30 天实际应用、约 12 周迁移验证"
        />
      </div>

      {formOpen && (
        <EvidenceForm
          key={retestContext?.scheduleId ?? parent?.id ?? 'new'}
          parent={parent}
          retest={retestContext}
          onToast={show}
          onDone={() => {
            setFormOpen(false);
            setParent(null);
          }}
        />
      )}

      <Card
        title="证据记录"
        description="点击一行展开条件、评分理由、附件与版本链；原始样本保存后不可覆盖。"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              aria-label="按技能筛选"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value as EvidenceSkill | 'ALL')}
              className={`${selectClass} w-auto`}
            >
              <option value="ALL">全部技能</option>
              {EVIDENCE_SKILLS.map((item) => (
                <option key={item} value={item}>
                  {EVIDENCE_SKILL_LABEL_ZH[item]}
                </option>
              ))}
            </select>
            <select
              aria-label="按类型筛选"
              value={typeFilter}
              onChange={(event) =>
                setTypeFilter(event.target.value as LearningEvidenceType | 'ALL')
              }
              className={`${selectClass} w-auto`}
            >
              <option value="ALL">全部类型</option>
              {LEARNING_EVIDENCE_TYPES.map((item) => (
                <option key={item} value={item}>
                  {LEARNING_EVIDENCE_TYPE_LABEL_ZH[item]}
                </option>
              ))}
            </select>
            <select
              aria-label="按级别筛选"
              value={levelFilter}
              onChange={(event) => setLevelFilter(event.target.value as EvidenceLevel | 'ALL')}
              className={`${selectClass} w-auto`}
            >
              <option value="ALL">全部级别</option>
              {EVIDENCE_LEVELS.map((item) => (
                <option key={item} value={item}>
                  {EVIDENCE_LEVEL_LABEL_ZH[item]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
                className="h-3.5 w-3.5"
              />
              含归档
            </label>
          </div>
        }
      >
        {filtered.length === 0 ? (
          rows.length === 0 ? (
            <EmptyState
              icon="check"
              title="还没有任何学习证据"
              description="先做一个小任务并留下原始样本：30 秒口语、3–5 句写作或一段短音频都可以作为基线。"
              dependencies={['已确认当前阶段与每周可持续时间（可选，用于解释条件）']}
              primary={{ label: '录入第一条证据', onClick: openCreate }}
            />
          ) : (
            <p className="py-6 text-center text-xs text-inkMuted">没有符合筛选条件的证据。</p>
          )
        ) : (
          <EvidenceList rows={filtered} onDerive={openDerive} onArchive={setArchiveTarget} />
        )}
      </Card>

      <ConfirmDialog
        open={archiveTarget !== null}
        title="归档这条证据？"
        description={
          archiveTarget
            ? `${LEARNING_EVIDENCE_TYPE_LABEL_ZH[archiveTarget.evidenceType]}（${EVIDENCE_SKILL_LABEL_ZH[archiveTarget.skill]}）将从默认列表隐藏，版本链与附件保留；此操作不删除历史。`
            : undefined
        }
        confirmLabel="归档"
        busy={pending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />

      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
