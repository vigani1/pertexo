import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowOrganizationProjectionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { workflowOrganizationProjectionQueryOptions } from '../../organization.queries';
import { useWorkflowOrganizationCommand } from '../../use-workflow-organization-command';

/** A row trigger owns no request or recovery lifetime. */
export function WorkflowFavoriteButton({
  workspace,
  workflow,
  onOpen,
  disabled = false,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflow: WorkflowOrganizationProjectionResponse;
  onOpen: () => void;
  disabled?: boolean;
}>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={
        disabled ||
        workspace.status !== 'active' ||
        !workspace.capabilities.includes('workflow:read')
      }
      aria-label={`Manage favorite for ${workflow.workflow.name}`}
      onClick={onOpen}
    >
      {workflow.organization.isFavorite ? 'Remove favorite' : 'Add favorite'}
    </Button>
  );
}

/** Mount independently of filtered rows. Desired state is never a blind toggle. */
export function WorkflowFavoriteDialog({
  apiClient,
  userId,
  workspace,
  workflow: initialWorkflow,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowOrganizationProjectionResponse;
  onClose: () => void;
}>) {
  const [workflow] = useState(initialWorkflow);
  const [preparing, setPreparing] = useState(false);
  const [readError, setReadError] = useState<string>();
  const preparingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const queryClient = useQueryClient();
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'member',
  });
  const options = workflowOrganizationProjectionQueryOptions(
    apiClient,
    userId,
    workspace.id,
    workflow.workflow.id,
    { include: 'organization' },
  );
  const projection = useQuery({
    ...options,
    staleTime: 0,
    enabled: !command.denied,
  });
  const allowed =
    workspace.status === 'active' &&
    workspace.capabilities.includes('workflow:read') &&
    !command.denied;
  const desired = !(
    projection.data?.organization.isFavorite ?? workflow.organization.isFavorite
  );
  const label = desired ? 'Add favorite' : 'Remove favorite';
  const locked = preparing || command.pending || command.retryAvailable;

  async function confirm() {
    if (
      locked ||
      preparingRef.current ||
      !allowed ||
      projection.data === undefined ||
      projection.isError ||
      command.error !== undefined ||
      command.result !== undefined
    )
      return;
    const favorite = desired;
    preparingRef.current = true;
    setPreparing(true);
    setReadError(undefined);
    try {
      const current = await queryClient.query({
        ...options,
        staleTime: 0,
      });
      if (!alive.current) return;
      await command.start({
        kind: 'favorite',
        workspaceId: workspace.id,
        workflowId: workflow.workflow.id,
        idempotencyKey: crypto.randomUUID(),
        body: {
          favorite,
          expectedFavoriteRevision: current.organization.favoriteRevision,
        },
      });
    } catch {
      if (alive.current)
        setReadError(
          'Current favorite could not be checked. No new command was sent. Refresh before confirming again.',
        );
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }
  async function refresh() {
    if (preparingRef.current || command.pending || command.denied) return;
    if (!command.retryAvailable) command.reset();
    setReadError(undefined);
    preparingRef.current = true;
    setPreparing(true);
    try {
      await projection.refetch({ throwOnError: true });
    } catch {
      if (alive.current)
        setReadError('Current favorite could not be refreshed.');
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next && locked) return;
        if (!next) onClose();
      }}
      title="Personal favorite"
      description={command.denied ? 'Access changed.' : workflow.workflow.name}
      confirmLabel={command.retryAvailable ? 'Retry original request' : label}
      pendingLabel={
        preparing ? 'Checking current favorite…' : 'Saving favorite…'
      }
      pending={preparing || command.pending}
      locked={locked}
      confirmDisabled={
        !allowed ||
        projection.data === undefined ||
        projection.isFetching ||
        projection.isError ||
        (command.error !== undefined && !command.retryAvailable) ||
        command.result !== undefined
      }
      onConfirm={command.retryAvailable ? command.retry : confirm}
      cancelLabel="Close"
      error={
        command.error ??
        readError ??
        (projection.isError
          ? 'Current favorite could not be loaded. Refresh before confirming.'
          : undefined)
      }
      errorTone={command.retryAvailable ? 'warning' : 'destructive'}
      secondaryAction={
        command.denied ? undefined : (
          <Button
            variant="outline"
            type="button"
            disabled={preparing || command.pending}
            onClick={() => {
              void refresh();
            }}
          >
            {command.retryAvailable
              ? 'Refresh current state'
              : 'Refresh for a new change'}
          </Button>
        )
      }
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        Favorites are private to your account, including on archived workflows.
        Exact recovery is available for 24 hours, not an indefinite
        duplicate-prevention guarantee. Refreshing current state preserves an
        unresolved request; only a known outcome permits a fresh change.
        Reloading this page loses in-memory recovery.
      </p>
      {command.denied || !projection.isFetching ? null : (
        <Notice>Reading current favorite…</Notice>
      )}
      {command.denied || command.result === undefined ? null : (
        <Notice tone="success">
          Favorite command accepted. Current favorite is refreshed separately.
        </Notice>
      )}
    </ConfirmDialog>
  );
}
