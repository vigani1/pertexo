import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { QueryView } from '@/components/patterns/states/query-view';
import type { WorkflowSummary } from '@pertexo/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import { pinnedParentsQueryOptions } from '../data/pins/queries';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  LIFECYCLE_CONSEQUENCES,
  type LifecycleIntent,
} from '../model/lifecycle';
import { useWorkflowLifecycleCommand } from '../data/workflows.mutations';

const COPY = {
  archive: {
    title: 'Archive this workflow?',
    confirm: 'Archive',
    pending: 'Archiving…',
    done: 'Workflow archived',
  },
  restore: {
    title: 'Restore this workflow?',
    confirm: 'Restore',
    pending: 'Restoring…',
    done: 'Workflow restored',
  },
} as const;

/**
 * Confirms archive or restore with its consequences spelled out. The intent
 * stays fixed while open, so a retry repeats exactly what was confirmed.
 */
export function WorkflowLifecycleDialog({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  workflowName,
  intent,
  onCompleted,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  intent: LifecycleIntent | undefined;
  /** Called once the change is confirmed, before the dialog closes. */
  onCompleted?: (() => void) | undefined;
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const lifecycle = useWorkflowLifecycleCommand({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const pins = useQuery(
    pinnedParentsQueryOptions({
      apiClient,
      userId,
      workspaceId,
      workflowId,
      enabled: intent?.command === 'archive',
    }),
  );
  const checkingPins = intent?.command === 'archive' && !lifecycle.exactRetry;
  const action = intent?.command ?? 'archive';
  const copy = COPY[action];

  async function confirm() {
    if (intent === undefined) return;
    const done = await lifecycle.submit(
      intent.command,
      intent.expectedLifecycleRevision,
    );
    if (!done) return;
    notifications.success({ title: copy.done, description: workflowName });
    onCompleted?.();
    onClose();
  }

  const pinCheckUnavailable =
    checkingPins && (pins.isPending || pins.isError || pins.isFetching);
  return (
    <ConfirmDialog
      state={{
        open: intent !== undefined,
        onOpenChange: (open) => {
          if (open) return;
          lifecycle.reset();
          onClose();
        },
        locked: lifecycle.pending,
      }}
      title={copy.title}
      description={
        <span className="font-medium text-foreground">{workflowName}</span>
      }
      onSubmit={confirm}
      submitDisabled={lifecycle.pending || pinCheckUnavailable}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={lifecycle.pending}
            render={<Button type="button" variant="ghost" />}
          >
            Cancel
          </DialogClose>
          <ProgressButton
            type="submit"
            variant={
              (action === 'restore' ? 'default' : 'destructive') ===
              'destructive'
                ? 'destructive'
                : 'primary'
            }
            pending={lifecycle.pending}
            pendingLabel={copy.pending}
            disabled={pinCheckUnavailable}
          >
            {lifecycle.exactRetry ? 'Retry safely' : copy.confirm}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        consequences={LIFECYCLE_CONSEQUENCES[action]}
        error={lifecycle.error}
        tone={lifecycle.exactRetry ? 'warning' : 'destructive'}
      >
        {intent?.command === 'archive' ? (
          <PublishedParentNotice query={pins} />
        ) : null}
      </ConfirmationDetails>
    </ConfirmDialog>
  );
}

function PublishedParentNotice({
  query,
}: Readonly<{ query: UseQueryResult<readonly WorkflowSummary[]> }>) {
  return (
    <QueryView
      query={query}
      resource="Published parents"
      loading={<p role="status">Checking published parent workflows…</p>}
    >
      {(parents) => <PublishedParents parents={parents} />}
    </QueryView>
  );
}

function PublishedParents({
  parents,
}: Readonly<{ parents: readonly WorkflowSummary[] }>) {
  if (parents.length === 0) return null;
  return (
    <Notice tone="warning" title="Published parents pin this workflow">
      <p>
        New Calls from these workflows will fail while this child is archived.
        Already accepted child runs continue.
      </p>
      <ul className="mt-2 list-disc pl-5">
        {parents.map((parent) => (
          <li key={parent.id}>{parent.name}</li>
        ))}
      </ul>
    </Notice>
  );
}
