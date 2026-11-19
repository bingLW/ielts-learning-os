'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toggleVocabConnectionAction } from '@/lib/actions/vocabIntegration';
import type { VocabConnectionDto } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Toast, useToastState } from '@/components/ui/Toast';

export function VocabConnectionToggle({ connection }: { connection: VocabConnectionDto }) {
  const router = useRouter();
  const { toast, show, dismiss } = useToastState();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    const result = await toggleVocabConnectionAction({
      connectionId: connection.id,
      enabled: !connection.enabled,
    });
    setBusy(false);
    if (!result.ok) {
      show(result.error, 'error');
      return;
    }
    show(connection.enabled ? '连接已关闭' : '连接已启用');
    router.refresh();
  };

  return (
    <>
      <Button variant={connection.enabled ? 'secondary' : 'primary'} size="sm" onClick={toggle} disabled={busy}>
        {connection.enabled ? '停用' : '启用'}
      </Button>
      <Toast toast={toast} onDismiss={dismiss} />
    </>
  );
}
