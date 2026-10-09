import type { WorkflowRunData } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useRunReplay } from '../../mutations/use-run-replay';
import { useRunInput } from '../../use-run-input';
import { workflowRunInputQueryOptions } from '../../workflow-run-data.queries';
import { RunInputFields } from '../run-input-fields';

/** The original input as the text the field shows, while it's still kept. */
function originalInputText(data: WorkflowRunData | undefined) {
  return data?.kind === 'inline'
    ? JSON.stringify(data.value, null, 2)
    : undefined;
}

/**
 * Replay starts a new run of this run's exact version. It opens with the
 * input the run used while Pertexo still keeps it (ADR 050), and an uncertain
 * result can be retried with the same command so it never runs twice.
 */
export function ReplayRunDialog({
  apiClient,
  userId,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  versionLabel,
  open,
  onOpenChange,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  /** "v7" when the version number is known. */
  versionLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunAccepted: (runId: string) => void;
}>) {
  const notifications = useNotifications();
  const runInput = useRunInput();
  const original = useQuery(
    workflowRunInputQueryOptions(apiClient, userId, workspaceId, sourceRunId),
  );
  const originalText = originalInputText(original.data);
  // Each time it opens, the field starts from the run's own input, and an
  // input that loads after opening fills a field nobody has typed in yet.
  const [seen, setSeen] = useState({ open, text: originalText });
  if (open !== seen.open || originalText !== seen.text) {
    const opening = open && !seen.open;
    const arrived =
      open && seen.open && seen.text === undefined && runInput.input === '{}';
    setSeen({ open, text: originalText });
    if (opening || arrived) runInput.reset(originalText);
  }
  const replay = useRunReplay({
    apiClient,
    userId,
    workspaceId,
    sourceRunId,
    workflowVersionId,
    onRunAccepted: (runId) => {
      notifications.success({
        title: 'Replay started',
        description: 'Opening the new run.',
      });
      onRunAccepted(runId);
    },
  });

  async function submit() {
    const intent = runInput.read();
    if (intent === undefined) return;
    const accepted = replay.retryAvailable
      ? await replay.retry(intent)
      : await replay.startNew(intent);
    if (accepted) onOpenChange(false);
  }

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      replay.dismiss();
      runInput.reset();
    }
  }

  const version = versionLabel ?? 'the same version';
  const description =
    originalText === undefined
      ? original.data?.kind === 'expired'
        ? `Pertexo starts a new run of ${version}. This run’s input is no longer kept, so enter the input to use. Steps that call other services run again.`
        : `Pertexo starts a new run of ${version} with the input you enter here. Steps that call other services run again, so check it before you continue.`
      : `Pertexo starts a new run of ${version} with this run’s input. Change it first if you need to: steps that call other services run again.`;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={changeOpen}
      title="Replay this run"
      description={description}
      confirmLabel={replay.retryAvailable ? 'Retry same replay' : 'Replay run'}
      pendingLabel="Replaying…"
      pending={replay.pending}
      error={replay.error}
      errorTone={replay.retryAvailable ? 'warning' : 'destructive'}
      onConfirm={submit}
    >
      <RunInputFields
        idPrefix="replay-run"
        inputLabel="Replay input (JSON)"
        runInput={runInput}
        disabled={replay.pending}
        autoFocus
      />
    </ConfirmDialog>
  );
}
