import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowImportRequest } from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
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
  | Readonly<{ kind: 'confirmed'; workflowId: string }>;

export function useWorkflowImportCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  lifetime: ReturnType<typeof usePortabilityLifetime>,
) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: async (body: WorkflowImportRequest, key) => {
      const request = lifetime.begin();
      try {
        await lifetime.verify({ signal: request.signal, creating: true });
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
  if (mutation.isPending) state = { kind: 'sending' };
  else if (mutation.isSuccess)
    state = { kind: 'confirmed', workflowId: mutation.data.workflowId };
  else if (mutation.isError)
    state = { kind: 'editable', failure: importRefusal(mutation.error) };
  return {
    state,
    clear: mutation.reset,
    start: (body: WorkflowImportRequest) => {
      if (mutation.isPending || lifetime.denied) return;
      void mutation.mutateAsync(body).catch((cause: unknown) => {
        lifetime.accessFailure(cause);
      });
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
    message: lowEffectError(cause, 'importing this workflow'),
    recovery: 'none',
  };
}
