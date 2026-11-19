'use client';

/**
 * AI 建议面板（P5：本地规则引擎建议）。
 *
 * - 三个 scope（弱项 / 周报 / 计划）各一个「生成」按钮，点击后真正生成并落库；
 * - 每条建议强制展示 `basis`（依据），并标注「仅供参考」；
 * - 无数据时返回可读的「暂无数据」提示，而不是假装成功。
 */

import { useState, useTransition } from 'react';
import { AI_SCOPE_LABEL_ZH } from '@/lib/constants';
import { requestAiAnalysisAction } from '@/lib/actions/ai';
import type { AiScope, AiSuggestionDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TagBadge } from '@/components/ui/StatusBadge';

export interface AiPanelProps {
  enabled: boolean;
  scopes: { scope: AiScope; label: string; latest: AiSuggestionDto | null }[];
  onToast?: (message: string, tone: 'success' | 'error') => void;
}

/** 单条依据展示 —— basis 强制展示，不可隐藏（R9）。 */
function BasisBlock({ basis }: { basis: string | null }) {
  return (
    <dl className="mt-1.5 rounded border border-line bg-surfaceAlt px-2 py-1.5 text-[11px]">
      <dt className="font-medium text-inkMuted">依据（basis）</dt>
      <dd className="mt-0.5 text-ink">{basis && basis.trim().length > 0 ? basis : '—'}</dd>
    </dl>
  );
}

export function AiPanel({ enabled, scopes, onToast }: AiPanelProps) {
  const [pendingScope, setPendingScope] = useState<AiScope | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = (scope: AiScope) => {
    setPendingScope(scope);
    startTransition(async () => {
      const result = await requestAiAnalysisAction({ scope });
      if (!result.ok) {
        onToast?.(result.error, 'error');
        setPendingScope(null);
        return;
      }
      onToast?.(`已生成 ${result.data.generated} 条「${AI_SCOPE_LABEL_ZH[scope]}」建议`, 'success');
      setPendingScope(null);
    });
  };

  return (
    <Card
      title="AI 建议（本地规则引擎）"
      description="每条建议都带数据依据（basis），仅供参考、不构成成绩，采纳前请自行确认。"
      actions={
        <TagBadge tone={enabled ? 'info' : 'neutral'}>
          {enabled ? '已启用' : '未启用'}
        </TagBadge>
      }
    >
      <div className="grid gap-2 md:grid-cols-3">
        {scopes.map((item) => (
          <div key={item.scope} className="rounded-md border border-line bg-white p-2.5">
            <div className="flex items-center justify-between gap-1">
              <h3 className="text-xs font-semibold text-ink">{item.label}</h3>
              <TagBadge tone={item.latest ? 'info' : 'neutral'}>
                {item.latest ? item.latest.statusLabel : '未生成'}
              </TagBadge>
            </div>

            {item.latest ? (
              <>
                <p className="mt-1 text-[11px] font-medium text-ink">{item.latest.title}</p>
                <p className="mt-0.5 text-[11px] text-inkMuted">{item.latest.body}</p>
                <BasisBlock basis={item.latest.basis} />
              </>
            ) : (
              <>
                <p className="mt-1 text-[11px] text-inkMuted">
                  还没有建议。点击「生成」从真实学习数据（弱项排序 / 周报指标 / 配比偏差）产出一条条带依据的建议。
                </p>
                <BasisBlock basis={null} />
              </>
            )}

            <div className="mt-2 flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled || pending}
                onClick={() => generate(item.scope)}
              >
                {pendingScope === item.scope ? '生成中…' : `生成${AI_SCOPE_LABEL_ZH[item.scope]}`}
              </Button>
              {!enabled && <span className="text-[10px] text-inkMuted">需先在设置开启</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
