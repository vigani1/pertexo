import type { WorkflowRecoveryPreview } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CornerDownRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError } from '@/lib/api/error-copy';
import { recoveryQueryOptions } from '../../data/recovery.queries';
import { useRunRecovery } from '../../data/mutations/use-run-recovery';
import { recoveryRefusal } from '../../model/commands/recovery';
import { RecoveryConfirmation } from './confirmation';
export function RunRecoveryAction({
  apiClient,
  userId,
  workspaceId,
  runId,
  workflowVersionId,
  compact,
  onRunAccepted,
  onReplay,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  compact: boolean;
  onRunAccepted: (id: string) => void;
  onReplay: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const command = useRunRecovery({
    apiClient,
    userId,
    workspaceId,
    sourceRunId: runId,
    workflowVersionId,
    onRunAccepted: (id) => {
      notifications.success({
        title: 'Recovery run started',
        description: 'Opening the new run.',
      });
      onRunAccepted(id);
    },
  });
  const preview = useQuery({
    ...recoveryQueryOptions(apiClient, userId, workspaceId, runId),
    enabled: open && !command.unconfirmed,
  });
  const unavailable = preview.data?.kind === 'refused';
  return (
    <>
      <Button
        type="button"
        variant={compact ? 'default' : 'outline'}
        className={compact ? 'flex-auto px-3' : undefined}
        onClick={() => {
          setOpen(true);
        }}
      >
        <CornerDownRightIcon aria-hidden="true" />
        {command.unconfirmed ? 'Retry same request' : 'Retry from this step'}
      </Button>
      {command.unconfirmed ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Retry same request"
          description="Check whether the original recovery request was accepted. The same version, step, deadline and acknowledgement are retained; this does not request a second run."
          confirmLabel="Retry same request"
          pendingLabel="Checking acceptance…"
          pending={command.pending}
          confirmDisabled={command.expired}
          error={command.error}
          errorTone="warning"
          onConfirm={() => command.retry()}
        >
          <p className="text-sm text-muted-foreground">
            The request stays in memory while this run page remains open. Check
            run history before leaving or reloading.
          </p>
        </ConfirmDialog>
      ) : null}
      {!command.unconfirmed && preview.data?.kind === 'eligible' ? (
        <RecoveryConfirmation
          preview={preview.data}
          command={command}
          open={open}
          onOpenChange={(next) => {
            if (!command.pending) setOpen(next);
          }}
        />
      ) : null}
      {!command.unconfirmed && preview.data?.kind !== 'eligible' ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Retry from this step"
          description={recoveryDescription(preview.data, preview.error)}
          confirmLabel={unavailable ? 'Use full replay…' : 'Check again'}
          pending={preview.isFetching}
          confirmDisabled={preview.isFetching}
          onConfirm={() => {
            if (unavailable) {
              setOpen(false);
              onReplay();
            } else void preview.refetch();
          }}
        />
      ) : null}
    </>
  );
}

function recoveryDescription(
  preview: WorkflowRecoveryPreview | undefined,
  error: unknown,
) {
  if (preview?.kind === 'refused') return recoveryRefusal(preview.reason);
  if (error === null) return 'Checking the saved execution results…';
  return describeReadError(error, 'recovery availability');
}
