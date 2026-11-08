import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import { useCallback, useRef, useState } from 'react';
import type { WorkflowImportRequest } from '@pertexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { importWorkflow } from './workflow-portability.api';
import { workflowKeys } from '../workflows.queries';
import { workflowOrganizationKeys } from '../organization/workflow-organization.queries';
import type { usePortabilityLifetime } from '../../components/portability/use-lifetime';

type Attempt = CommandKey & {
  body: WorkflowImportRequest;
  workflowId?: string;
};
type ImportRefusal = Readonly<{
  message: string;
  recovery: 'preview' | 'none';
}>;
export type WorkflowImportCommandState =
  | Readonly<{ kind: 'editable'; failure?: ImportRefusal }>
  | Readonly<{ kind: 'sending' }>
  | Readonly<{ kind: 'uncertain'; error: string }>
  | Readonly<{ kind: 'confirmed'; workflowId: string }>;

export function useWorkflowImportCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  lifetime: ReturnType<typeof usePortabilityLifetime>,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<WorkflowImportCommandState>({
    kind: 'editable',
  });
  const attempt = useRef<Attempt | undefined>(undefined);
  const busy = useRef(false);
  const clear = useCallback(() => {
    attempt.current = undefined;
    setState({ kind: 'editable' });
  }, []);
  async function send(command: Attempt) {
    if (busy.current || lifetime.denied) return;
    busy.current = true;
    setState({ kind: 'sending' });
    const request = lifetime.begin();
    let phase: 'authority' | 'mutation' | 'accepted' =
      command.workflowId === undefined ? 'authority' : 'accepted';
    try {
      await lifetime.verify({ signal: request.signal, creating: true });
      if (!request.current()) return;
      let createdWorkflowId = command.workflowId;
      if (createdWorkflowId === undefined) {
        phase = 'mutation';
        const result = await importWorkflow({
          apiClient,
          workspaceId,
          body: command.body,
          idempotencyKey: command.idempotencyKey,
          signal: request.signal,
        });
        command.workflowId = result.workflowId;
        createdWorkflowId = result.workflowId;
      }
      phase = 'accepted';
      if (!request.current()) return;
      await lifetime.verify({ signal: request.signal, creating: true });
      if (!request.current()) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]);
      if (!request.current()) return;
      setState({ kind: 'confirmed', workflowId: createdWorkflowId });
    } catch (error) {
      if (!request.current() || lifetime.accessFailure(error)) return;
      const requiresIntentRecovery = importNeedsRecovery({
        phase,
        state,
        error,
      });
      if (requiresIntentRecovery) {
        setState({
          kind: 'uncertain',
          error:
            command.workflowId === undefined
              ? 'We couldn’t confirm whether the import went through. Retry the exact import to recover it; check existing workflows before starting a new import if recovery has expired.'
              : 'The workflow was created, but access couldn’t be reverified. Retry to verify access and open that existing workflow.',
        });
      } else {
        attempt.current = undefined;
        setState({
          kind: 'editable',
          failure: importRefusal(error),
        });
      }
    } finally {
      request.done();
      busy.current = false;
    }
  }
  return {
    state,
    clear,
    start: (body: WorkflowImportRequest) => {
      if (state.kind !== 'editable' || busy.current || lifetime.denied) return;
      const command = { body: structuredClone(body), ...newCommandKey() };
      attempt.current = command;
      void send(command);
    },
    retry: () => {
      const current = attempt.current;
      if (state.kind !== 'uncertain' || current === undefined) return;
      // An accepted import only needs its access re-verified.
      if (current.workflowId !== undefined || canResend(current))
        void send(current);
      else {
        attempt.current = undefined;
        setState({
          kind: 'editable',
          failure: { message: RETRY_WINDOW_ENDED, recovery: 'none' },
        });
      }
    },
  };
}

function importNeedsRecovery({
  phase,
  state,
  error,
}: Readonly<{
  phase: 'authority' | 'mutation' | 'accepted';
  state: WorkflowImportCommandState;
  error: unknown;
}>): boolean {
  const rejected =
    phase === 'mutation' &&
    isApiError(error) &&
    error.kind === 'problem' &&
    [400, 409, 412, 422, 428].includes(error.status ?? 0);
  return (
    phase === 'accepted' ||
    (!rejected &&
      (state.kind === 'uncertain' ||
        (phase === 'mutation' && isUnconfirmedCommand(error))))
  );
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
