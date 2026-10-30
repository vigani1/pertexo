import { useCaseOwner } from './use-case-owner';
import { canResend, isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { useCallback, useState } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { WorkflowInputCase } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session/identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  getInputCase,
  sendInputCaseCommand,
  type InputCaseCommand,
} from '../data/input-cases/api';
import {
  inputCasesKey,
  inputCasesQueryOptions,
} from '../data/input-cases/queries';

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
    return 'We couldn’t confirm this change. Retry the exact change within 24 hours; other changes are blocked until it is resolved.';
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
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const onClose = useCallback(() => {
    setSelected(undefined);
    setError(undefined);
    setPending(false);
    setUncertain(false);
    setConflict(false);
    setAccessLost(false);
  }, []);
  const onRetire = useCallback(() => {
    setSelected(undefined);
    setUncertain(false);
    setConflict(false);
    setAccessLost(true);
    setPending(false);
  }, []);
  const { ownerRef, controllerRef, retainedRef, retire } = useCaseOwner({
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
        uncertain,
        accessLost,
        retire,
        setPending,
        setError,
        setSelected,
        setConflict,
      },
      caseId,
    );

  const send = (input: CaseSendInput) =>
    sendInputCase(
      {
        api,
        userId,
        workspaceId,
        workflowId,
        cache,
        ownerRef,
        controllerRef,
        retainedRef,
        retire,
        canWrite,
        accessLost,
        setPending,
        setError,
        setSelected,
        setConflict,
        setUncertain,
      },
      input,
    );
  return {
    scope: { apiClient: api, userId, workspaceId, workflowId },
    query,
    selected,
    error,
    pending,
    uncertain,
    conflict,
    accessLost,
    read,
    send,
    clearSelection: () => {
      setSelected(undefined);
    },
    retry: () =>
      retainedRef.current === undefined
        ? Promise.resolve(false)
        : send({ command: retainedRef.current.command, retry: true }),
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
  command: InputCaseCommand;
  retry?: boolean | undefined;
}>;
type CaseSendContext = Pick<
  ReturnType<typeof useCaseOwner>,
  'ownerRef' | 'controllerRef' | 'retainedRef' | 'retire'
> &
  Readonly<{
    api: ApiClient;
    userId: string;
    workspaceId: string;
    workflowId: string;
    cache: QueryClient;
    canWrite: boolean;
    accessLost: boolean;
    setPending: (value: boolean) => void;
    setError: (value: string | undefined) => void;
    setSelected: (value: WorkflowInputCase | undefined) => void;
    setConflict: (value: boolean) => void;
    setUncertain: (value: boolean) => void;
  }>;
async function sendInputCase(
  {
    api,
    userId,
    workspaceId,
    workflowId,
    cache,
    ownerRef,
    controllerRef,
    retainedRef,
    retire,
    canWrite,
    accessLost,
    setPending,
    setError,
    setSelected,
    setConflict,
    setUncertain,
  }: CaseSendContext,
  { command, retry = false }: CaseSendInput,
) {
  const inputCaseCommandBlocked =
    controllerRef.current !== undefined ||
    !canWrite ||
    accessLost ||
    (!retry && retainedRef.current !== undefined);
  if (inputCaseCommandBlocked) return false;
  const token = ownerRef.current;
  if (token === undefined) return false;
  const attempt = retry
    ? retainedRef.current
    : { command, createdAt: Date.now() };
  if (attempt === undefined) return false;
  if (!canResend(attempt)) {
    setError(
      'The 24-hour recovery window has ended. Inspect current cases before making another change; this retry can no longer guarantee the original result.',
    );
    return false;
  }
  const abort = new AbortController();
  controllerRef.current = abort;
  setPending(true);
  setError(undefined);
  let dispatched = false;
  try {
    if (
      !(await verifyCaseWrite({
        api,
        userId,
        workspaceId,
        ownerRef,
        retire,
        token,
        signal: abort.signal,
      }))
    )
      return false;
    retainedRef.current = attempt;
    dispatched = true;
    await sendInputCaseCommand(api, workspaceId, workflowId, attempt.command);
    if (ownerRef.current !== token) return false;
    retainedRef.current = undefined;
    setUncertain(false);
    setSelected(undefined);
    setConflict(false);
    await cache.invalidateQueries({
      queryKey: inputCasesKey(userId, workspaceId, workflowId),
    });
    return true;
  } catch (cause) {
    if (ownerRef.current !== token) return false;
    if (dispatched) {
      const unknown = isUnconfirmedCommand(cause);
      setUncertain(unknown);
      if (!unknown) retainedRef.current = undefined;
    }
    if (denied(cause)) {
      retire();
    }
    const code = isApiError(cause) ? cause.problem?.code : undefined;
    setConflict(code === 'workflow.input_case_revision_conflict');
    setError(caseCommandError(cause));
    return false;
  } finally {
    finishCaseRequest({ controllerRef, ownerRef, abort, token, setPending });
  }
}

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
