import { useRouter } from '@tanstack/react-router';
import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useWorkflowVersionRestore,
  type RestoreRecovery,
} from '../../data/mutations/use-version-restore';

const CONFIRM: Readonly<Record<RestoreRecovery | 'start', string>> = {
  start: 'Restore to draft',
  'check-outcome': 'Check again',
  'retry-original': 'Retry restore',
  'confirm-replacement': 'Replace newer draft',
};

/**
 * "Your draft will be replaced by v5." The draft is checked before and after,
 * so a newer draft is only replaced after a second, explicit confirmation.
 */
export function RestoreVersionDialog({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  version,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  version: WorkflowVersionResponse;
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const router = useRouter();
  const restore = useWorkflowVersionRestore({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const label = `v${String(version.versionNumber)}`;

  async function confirm() {
    const result = await restore.restore(version);
    if (result === false) return;
    notifications.success({
      title: `Draft restored from ${label}`,
      description:
        result.recoveryCopyId === null ? (
          'Open Build to review it, then publish when ready.'
        ) : (
          <>
            Your unpublished changes were saved as a copy:{' '}
            <a
              href={
                router.buildLocation({
                  to: '/w/$workspaceId/workflows/$workflowId',
                  params: { workspaceId, workflowId: result.recoveryCopyId },
                }).href
              }
              className="inline-link"
            >
              Open copy
            </a>
          </>
        ),
    });
    onClose();
  }

  return (
    <ConfirmDialog
      state={{
        open: true,
        onOpenChange: (open) => {
          if (open) return;
          restore.dismiss();
          onClose();
        },
        locked: restore.pending,
      }}
      title={`Restore ${label} to the draft?`}
      description={`Your draft will be replaced by ${label}. Published versions don’t change. Unpublished changes will be saved as a separate disabled copy in the same folder.`}
      onSubmit={confirm}
      submitDisabled={restore.pending}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={restore.pending}
            render={<Button type="button" variant="ghost" />}
          >
            Cancel
          </DialogClose>
          <ProgressButton
            type="submit"
            variant={
              (restore.recovery === 'confirm-replacement'
                ? 'destructive'
                : 'default') === 'destructive'
                ? 'destructive'
                : 'primary'
            }
            pending={restore.pending}
            pendingLabel="Restoring…"
          >
            {CONFIRM[restore.recovery ?? 'start']}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={restore.error}
        tone={restore.recovery === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
