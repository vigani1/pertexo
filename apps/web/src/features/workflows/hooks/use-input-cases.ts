import { useCaseOwner } from './use-case-owner';
import { isUnconfirmedCommand } from '@/lib/api/commands/command-retry';
import { useCallback, useState } from 'react';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowInputCase } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session/identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/workspaces-queries.public';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  getInputCase,
  sendInputCaseCommand,
  type InputCaseIntent,
} from '../data/input-cases/workflow-input-cases.api';
import {
  inputCasesKey,
  inputCasesQueryOptions,
} from '../data/input-cases/workflow-input-cases.queries';

function denied(cause: unknown) {
  return (
    isSessionIdentityChangedError(cause) ||
    (isApiError(cause) && [401, 403, 404].includes(cause.status ?? 0))
  );
}

function caseCommandError(cause: unknown) {
  const code = isApiError(cause) ? cause.problem?.code : undefined;
  if (code === 'workflow.input_case_revision_conflict')
    return 'This case changed elsewhere. Your edits are still here. Read the current case and review before confirming a new change.';
  if (code === 'workflow.input_case_limit_exceeded')
    return 'This workspace or workflow has reached its input-case limit. Remove an unneeded case and try again.';
  if (isUnconfirmedCommand(cause))
    return lowEffectError(cause, 'changing this input case');
  return describeCommandError(cause, 'changing this input case');
}

/** Metadata in Query, opened payload and exact command only in this owner. */
export function useInputCases({
  api,
  userId,
  workspaceId,
  workflowId,
  canWrite,
  enabled = true,
}: Readonly<{
  api: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  canWrite: boolean;
  enabled?: boolean | undefined;
}>) {
  const cache = useQueryClient();
  const query = useInfiniteQuery({
    ...inputCasesQueryOptions(api, userId, workspaceId, workflowId),
    enabled,
  });
  const [selected, setSelected] = useState<WorkflowInputCase>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const onClose = useCallback(() => {
    setSelected(undefined);
    setError(undefined);
    setPending(false);
    setConflict(false);
    setAccessLost(false);
  }, []);
  const onRetire = useCallback(() => {
    setSelected(undefined);
    setConflict(false);
    setAccessLost(true);
    setPending(false);
  }, []);
  const { ownerRef, controllerRef, retire } = useCaseOwner({
    api,
    cache,
    userId,
    workspaceId,
    workflowId,
    canWrite,
    enabled,
    onClose,
    onRetire,
  });

  const read = (caseId: string) =>
    readInputCase(
      {
        api,
        workspaceId,
        workflowId,
        ownerRef,
        controllerRef,
        uncertain: false,
        accessLost,
        retire,
        setPending,
        setError,
        setSelected,
        setConflict,
      },
      caseId,
    );

  const mutation = useLowEffectMutation({
    send: async ({ command }: CaseSendInput, key) => {
      const token = ownerRef.current;
      if (token === undefined) throw new Error('The input case is closed.');
      const controller = new AbortController();
      if (
        !(await verifyCaseWrite({
          api,
          userId,
          workspaceId,
          ownerRef,
          retire,
          token,
          signal: controller.signal,
        }))
      )
        throw new Error('This input case can’t be changed.');
      return sendInputCaseCommand(api, workspaceId, workflowId, {
        ...command,
        key,
      });
    },
    refresh: () =>
      cache.invalidateQueries({
        queryKey: inputCasesKey(userId, workspaceId, workflowId),
      }),
  });
  async function send(input: CaseSendInput) {
    if (mutation.isPending || pending || !canWrite || accessLost) return false;
    setError(undefined);
    try {
      await mutation.mutateAsync(input);
      setSelected(undefined);
      setConflict(false);
      return true;
    } catch (cause) {
      const code = isApiError(cause) ? cause.problem?.code : undefined;
      setConflict(code === 'workflow.input_case_revision_conflict');
      setError(caseCommandError(cause));
      return false;
    }
  }
  return {
    scope: { apiClient: api, userId, workspaceId, workflowId },
    query,
    selected,
    error,
    pending: pending || mutation.isPending,
    conflict,
    accessLost,
    read,
    send,
    clearSelection: () => {
      setSelected(undefined);
    },
  };
}

type CaseReadContext = Pick<
  ReturnType<typeof useCaseOwner>,
  'ownerRef' | 'controllerRef' | 'retire'
> &
  Readonly<{
    api: ApiClient;
    workspaceId: string;
    workflowId: string;
    uncertain: boolean;
    accessLost: boolean;
    setPending: (value: boolean) => void;
    setError: (value: string | undefined) => void;
    setSelected: (value: WorkflowInputCase) => void;
    setConflict: (value: boolean) => void;
  }>;
async function readInputCase(
  {
    api,
    workspaceId,
    workflowId,
    ownerRef,
    controllerRef,
    uncertain,
    accessLost,
    retire,
    setPending,
    setError,
    setSelected,
    setConflict,
  }: CaseReadContext,
  caseId: string,
) {
  if (controllerRef.current !== undefined || uncertain || accessLost)
    return undefined;
  const token = ownerRef.current;
  if (token === undefined) return undefined;
  const abort = new AbortController();
  controllerRef.current = abort;
  setPending(true);
  setError(undefined);
  try {
    const result = await getInputCase({
      api,
      workspaceId,
      workflowId,
      caseId,
      signal: abort.signal,
    });
    if (ownerRef.current !== token) return undefined;
    setSelected(result);
    setConflict(false);
    return result;
  } catch (cause) {
    if (ownerRef.current === token)
      setError(describeCommandError(cause, 'opening the input case'));
    if (denied(cause) && ownerRef.current === token) {
      retire();
    }
    return undefined;
  } finally {
    finishCaseRequest({ controllerRef, ownerRef, abort, token, setPending });
  }
}
async function verifyCaseWrite({
  api,
  userId,
  workspaceId,
  ownerRef,
  retire,
  token,
  signal,
}: Readonly<
  Pick<ReturnType<typeof useCaseOwner>, 'ownerRef' | 'retire'> & {
    api: ApiClient;
    userId: string;
    workspaceId: string;
    token: symbol;
    signal: AbortSignal;
  }
>) {
  await assertSessionIdentity(api, userId, signal);
  const workspace = (await getAllAccessibleWorkspaces(api, signal)).find(
    (item) => item.id === workspaceId,
  );
  if (ownerRef.current !== token) return false;
  if (
    workspace?.status !== 'active' ||
    !workspace.capabilities.includes('workflow:update')
  ) {
    retire();
    return false;
  }
  return true;
}

type CaseSendInput = Readonly<{
  command: InputCaseIntent;
}>;
function finishCaseRequest({
  controllerRef,
  ownerRef,
  abort,
  token,
  setPending,
}: Readonly<
  Pick<ReturnType<typeof useCaseOwner>, 'controllerRef' | 'ownerRef'> & {
    abort: AbortController;
    token: symbol;
    setPending: (value: boolean) => void;
  }
>) {
  if (controllerRef.current !== abort) return;
  controllerRef.current = undefined;
  if (ownerRef.current === token) setPending(false);
}
