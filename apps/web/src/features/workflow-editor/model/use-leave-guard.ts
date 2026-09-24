import { useBlocker } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import type { EditorStore } from './editor.store';

export type LeaveReason = 'unsaved' | 'unfinished' | 'comparison';

/**
 * Router navigation protection for the editor: unsaved graph changes, an
 * unfinished inspector edit, or a kept conflict copy all ask before leaving.
 * "Save and leave" flushes the save and only proceeds once it's clean.
 */
export function useLeaveGuard({
  store,
  flushSave,
}: Readonly<{ store: EditorStore; flushSave: () => Promise<void> }>) {
  const [saving, setSaving] = useState(false);
  const reasonFor = useCallback((): LeaveReason | undefined => {
    const state = store.getState();
    if (state.inspectorScratch) return 'unfinished';
    if (state.saveStatus !== 'clean') return 'unsaved';
    if (state.conflict !== null) return 'comparison';
    return undefined;
  }, [store]);
  const shouldBlock = useCallback(() => reasonFor() !== undefined, [reasonFor]);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });
  const reason =
    blocker.status === 'blocked' ? (reasonFor() ?? 'unsaved') : 'unsaved';

  async function saveAndLeave() {
    if (blocker.status !== 'blocked') return;
    setSaving(true);
    try {
      await flushSave();
    } finally {
      setSaving(false);
    }
    if (reasonFor() === undefined) blocker.proceed();
  }

  return { blocker, reason, saving, saveAndLeave } as const;
}
