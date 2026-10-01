import { useCallback, useRef, useState } from 'react';
import type { WorkflowImportRequest } from '@pertexo/contracts/schemas/workflow-portability';
import { useQueryClient } from '@tanstack/react-query';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { importWorkflow } from './workflow-portability.api';
import { workflowKeys } from './workflows.queries';
import type { usePortabilityLifetime } from './components/portability/use-portability-lifetime';

interface Attempt {
  body: WorkflowImportRequest;
  key: string;
  workflowId?: string;
}
interface CommandState {
  kind: 'editable' | 'sending' | 'uncertain' | 'confirmed';
  error?: string;
  workflowId?: string;
}

export function useWorkflowImportCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  lifetime: ReturnType<typeof usePortabilityLifetime>,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CommandState>({ kind: 'editable' });
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
      if (!(await lifetime.verify(request.signal, true)) || !request.current())
        return;
      if (command.workflowId === undefined) {
        phase = 'mutation';
        const result = await importWorkflow(
          apiClient,
          workspaceId,
          command.body,
          command.key,
          request.signal,
        );
        command.workflowId = result.workflowId;
      }
      phase = 'accepted';
      if (
        !request.current() ||
        !(await lifetime.verify(request.signal, true)) ||
        !request.current()
      )
        return;
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
      setState({ kind: 'confirmed', workflowId: command.workflowId });
    } catch (error) {
      if (!request.current() || lifetime.accessFailure(error)) return;
      const rejected =
        phase === 'mutation' &&
        isApiError(error) &&
        error.kind === 'problem' &&
        [400, 409, 412, 422, 428].includes(error.status ?? 0);
      if (
        phase === 'accepted' ||
        (!rejected &&
          (state.kind === 'uncertain' ||
            (phase === 'mutation' && isUncertainOutcome(error))))
      ) {
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
          error: describeCommandError(error, 'importing this workflow'),
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
      const command = { body: structuredClone(body), key: crypto.randomUUID() };
      attempt.current = command;
      void send(command);
    },
    retry: () => {
      if (state.kind === 'uncertain' && attempt.current !== undefined)
        void send(attempt.current);
    },
  };
}
