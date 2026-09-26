import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
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
 * start keeps its idempotency key, so Try again can't start it twice.
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

  async function run(workflow: WorkflowSummary): Promise<void> {
    if (busy.current) return;
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
      onRunStarted(started.id);
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
