/**
 * 证据抽屉（只读展示）。数据由服务端页面按 `?evidence=<id>` 取好再传入 ——
 * 组件层**不得**值导入 `queries/*`（G-5③），因此这里没有取数逻辑。
 */

import { Card } from '@/components/ui/Card';
import {
  EVIDENCE_CONFIDENCE_LABEL_ZH,
  EVIDENCE_SKILL_LABEL_ZH,
} from '@/lib/constants';
import type { EvidenceDetailDto, EvidenceSkill } from '@/lib/types';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-xs">
      <dt className="text-inkMuted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

export function EvidenceDrawer({
  evidenceId,
  evidence,
  closeHref,
}: {
  evidenceId: string;
  evidence: EvidenceDetailDto | null;
  closeHref: string;
}) {
  if (!evidence) {
    return (
      <Card
        title="证据详情"
        description={`evidenceId=${evidenceId}`}
        actions={<a href={closeHref} className="text-xs text-brand">关闭</a>}
      >
        <p className="text-xs text-inkMuted">未找到该证据（可能已按保留策略清理）。</p>
      </Card>
    );
  }

  const skillLabel = EVIDENCE_SKILL_LABEL_ZH[evidence.skill as EvidenceSkill] ?? evidence.skill;
  return (
    <Card
      title={`证据详情 · ${skillLabel}`}
      description={`evidenceId=${evidence.id}`}
      actions={<a href={closeHref} className="text-xs text-brand">关闭</a>}
    >
      <dl className="divide-y divide-line">
        <Row label="证据类型">{evidence.evidenceType}</Row>
        <Row label="生命周期层级">{evidence.level}</Row>
        <Row label="记录时间">{evidence.createdAt.slice(0, 10)}</Row>
        <Row label="独立性">
          {evidence.independent ? 'A0 独立表现' : '非独立（含辅助）'} · {evidence.assistanceLevel}
        </Row>
        <Row label="评分">{evidence.score === null ? '无（定性证据）' : evidence.score}</Row>
        <Row label="置信度">{EVIDENCE_CONFIDENCE_LABEL_ZH[evidence.confidence]}</Row>
        <Row label="产出摘录">{evidence.outputText ?? evidence.outputPreview ?? '无'}</Row>
        <Row label="评分依据">{evidence.scoreReason ?? '未记录'}</Row>
        <Row label="隐私级别">{evidence.privacyLevel}</Row>
        <Row label="附件">
          {evidence.artifact ? `${evidence.artifact.fileUri}（${evidence.artifact.consentStatus}）` : '无'}
        </Row>
        <Row label="链关系">
          父 {evidence.parentEvidenceId ?? '无'} · 子 {evidence.childCount} 条
        </Row>
      </dl>
    </Card>
  );
}