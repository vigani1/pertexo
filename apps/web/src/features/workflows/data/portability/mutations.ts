import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowImportRequest } from '@pertexo/contracts';
import { useCreateCommand } from '@/lib/api/commands/use-create-command';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { importWorkflow } from './workflow-portability.api';
import { workflowKeys } from '../workflows.queries';
import { workflowOrganizationKeys } from '../organization/workflow-organization.queries';
import type { usePortabilityLifetime } from '../../components/portability/use-portability-lifetime';

type ImportRefusal = Readonly<{
  message: string;
  recovery: 'preview' | 'none';
}>;
export type WorkflowImportCommandState =
  | Readonly<{ kind: 'editable'; failure?: ImportRefusal }>
  | Readonly<{ kind: 'sending' }>
  /** The import may have created a workflow; only its exact resend is safe. */
  | Readonly<{ kind: 'uncertain' }>
  /** The held import outlived its receipt; the person checks before a new one. */
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'confirmed'; workflowId: string }>;

export function useWorkflowImportCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  lifetime: ReturnType<typeof usePortabilityLifetime>,
) {
  const cache = useQueryClient();
  const command = useCreateCommand({
    send: async (body: WorkflowImportRequest, key) => {
      const request = lifetime.begin();
      try {
        return await importWorkflow({
          apiClient,
          workspaceId,
          body,
          idempotencyKey: key,
          signal: request.signal,
        });
      } finally {
        request.done();
      }
    },
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]),
  });
  let state: WorkflowImportCommandState = { kind: 'editable' };
  if (command.pending) state = { kind: 'sending' };
  else if (command.expired) state = { kind: 'expired' };
  else if (command.data !== undefined)
    state = { kind: 'confirmed', workflowId: command.data.workflowId };
  else if (command.uncertain) state = { kind: 'uncertain' };
  else if (command.failed)
    state = { kind: 'editable', failure: importRefusal(command.error) };
  function send(sending: () => Promise<unknown>) {
    if (command.pending || lifetime.denied) return;
    void sending().catch((cause: unknown) => {
      lifetime.accessFailure(cause);
    });
  }
  return {
    state,
    clear: command.startNewAttempt,
    start: (body: WorkflowImportRequest) => {
      send(() => command.create(body));
    },
    retry: () => {
      send(command.retry);
    },
  };
}

function importRefusal(cause: unknown): ImportRefusal {
  if (
    isApiError(cause) &&
    cause.problem?.code === 'workflow.portability_compatibility_conflict'
  )
    return {
      message:
        cause.problem.detail ??
        'The destination catalog changed. Preview this import again before creating its draft.',
      recovery: 'preview',
    };
  if (
    isApiError(cause) &&
    cause.problem?.code === 'workflow.portability_invalid'
  )
    return {
      message:
        cause.problem.detail ??
        'The imported content needs repair. Preview it again and review the compatibility findings.',
      recovery: 'preview',
    };
  return {
    message: describeCommandError(cause, 'importing this workflow'),
    recovery: 'none',
  };
}
