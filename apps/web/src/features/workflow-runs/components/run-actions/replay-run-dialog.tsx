import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useRunReplay } from '../../mutations/use-run-replay';
import { useRunInput } from '../../use-run-input';
import { RunInputFields } from '../run-input-fields';

/**
 * Replay starts a new run of this run's exact version. The input is typed
 * explicitly (the API doesn't return the original yet), and an uncertain
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
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={changeOpen}
      title="Replay this run"
      description={`Pertexo starts a new run of ${version} with the input you enter here. It doesn’t copy the original input, and steps that call other services run again, so check the input before you continue.`}
      confirmLabel={
        replay.retryAvailable ? 'Retry same replay' : 'Replay this version'
      }
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
