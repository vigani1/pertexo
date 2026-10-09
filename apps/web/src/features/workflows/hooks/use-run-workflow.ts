import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowSummary } from '@pertexo/contracts';
import { useNotifications } from '@/components/ui/use-notifications';
import { startWorkflowRun } from '@/features/workflow-runs/commands.public';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';

/**
 * Runs a workflow's published version from the list, with an empty input like
 * Build's "Run published version", then opens the new run. An unconfirmed
 * start keeps its idempotency key, so Try again can't start it twice. A start
 * confirmed after you left the list, or switched workspace, only says so: it
 * doesn't take you back.
 */
export function useRunWorkflow({
  apiClient,
  userId,
  workspaceId,
  onRunStarted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  onRunStarted: (runId: string) => void;
}>) {
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const [pendingId, setPendingId] = useState<string>();
  const busy = useRef(false);
  const unconfirmed = useRef(new Map<string, string>());
  // The list, in one workspace, that a start's answer may still act on.
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const current = Symbol('run-workflow');
    owner.current = current;
    return () => {
      if (owner.current === current) owner.current = undefined;
    };
  }, [apiClient, userId, workspaceId]);

  async function run(workflow: WorkflowSummary): Promise<void> {
    if (busy.current) return;
    const runOwner = owner.current;
    busy.current = true;
    const idempotencyKey =
      unconfirmed.current.get(workflow.id) ?? crypto.randomUUID();
    unconfirmed.current.set(workflow.id, idempotencyKey);
    setPendingId(workflow.id);
    try {
      const { run: started } = await startWorkflowRun(
        apiClient,
        workspaceId,
        workflow.id,
        { value: {}, idempotencyKey },
      );
      unconfirmed.current.delete(workflow.id);
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
      if (runOwner !== undefined && owner.current === runOwner)
        onRunStarted(started.id);
      else notifications.success({ title: `${workflow.name} started` });
    } catch (cause) {
      const uncertain = isUncertainOutcome(cause);
      if (!uncertain) unconfirmed.current.delete(workflow.id);
      notifications.error(
        uncertain
          ? {
              title: `We couldn’t confirm whether ${workflow.name} started`,
              description:
                'Try again: Pertexo recognizes the repeat, so it can’t start twice.',
              action: {
                label: 'Try again',
                onClick: () => void run(workflow),
              },
            }
          : {
              title: `${workflow.name} didn’t start`,
              description: describeCommandError(cause, 'starting this run'),
            },
      );
    } finally {
      busy.current = false;
      setPendingId(undefined);
    }
  }

  return { pendingId, run };
}
