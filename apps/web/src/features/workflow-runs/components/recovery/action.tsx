import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import type {
  AccessibleWorkspace,
  WorkflowRecoveryPreview,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CornerDownRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError } from '@/lib/api/error-copy';
import { recoveryQueryOptions } from '../../data/recovery.queries';
import { useRunRecovery } from '../../data/mutations/use-run-recovery';
import { recoveryRefusal } from '../../model/commands/recovery';
import { useNewerPublishedVersion } from '../../hooks/use-newer-published-version';
import { RecoveryConfirmation } from './confirmation';
export function RunRecoveryAction({
  apiClient,
  userId,
  workspace,
  runId,
  workflowId,
  workflowVersionId,
  compact,
  onRunAccepted,
  onReplay,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: Pick<AccessibleWorkspace, 'id' | 'capabilities'>;
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  compact: boolean;
  onRunAccepted: (id: string) => void;
  onReplay: () => void;
}>) {
  const workspaceId = workspace.id;
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const published = useNewerPublishedVersion({
    apiClient,
    userId,
    workspace,
    source: { workflowId, workflowVersionId },
    enabled: open,
  });
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
          state={{ open: open, onOpenChange: setOpen, locked: command.pending }}
          title="Retry same request"
          description="Check whether the original recovery request was accepted. The same version, step, deadline and acknowledgement are retained; this does not request a second run."
          onSubmit={() => command.retry()}
          submitDisabled={command.pending || command.expired}
          footer={
            <ConfirmationFooter>
              <DialogClose
                disabled={command.pending}
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </DialogClose>
              <ProgressButton
                type="submit"
                variant="primary"
                pending={command.pending}
                pendingLabel="Checking acceptance…"
                disabled={command.expired}
              >
                Retry same request
              </ProgressButton>
            </ConfirmationFooter>
          }
        >
          <ConfirmationDetails error={command.error} tone="warning">
            <p className="text-sm text-muted-foreground">
              The request stays in memory while this run page remains open.
              Check run history before leaving or reloading.
            </p>
          </ConfirmationDetails>
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
          newerVersionNumber={published.newer?.versionNumber}
          onReplay={() => {
            setOpen(false);
            onReplay();
          }}
        />
      ) : null}
      {!command.unconfirmed && preview.data?.kind !== 'eligible' ? (
        <ConfirmDialog
          state={{
            open: open,
            onOpenChange: setOpen,
            locked: preview.isFetching,
          }}
          title="Retry from this step"
          description={recoveryDescription(preview.data, preview.error)}
          onSubmit={() => {
            if (unavailable) {
              setOpen(false);
              onReplay();
            } else void preview.refetch();
          }}
          submitDisabled={preview.isFetching || preview.isFetching}
          footer={
            <ConfirmationFooter>
              <DialogClose
                disabled={preview.isFetching}
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </DialogClose>
              <ProgressButton
                type="submit"
                variant="primary"
                pending={preview.isFetching}
                pendingLabel={unavailable ? 'Use full replay…' : 'Check again'}
                disabled={preview.isFetching}
              >
                {unavailable ? 'Use full replay…' : 'Check again'}
              </ProgressButton>
            </ConfirmationFooter>
          }
        ></ConfirmDialog>
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
