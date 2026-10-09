import { useCallback, useEffect, useRef, useState } from 'react';
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
} from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import {
  getInputCase,
  sendInputCaseCommand,
  type InputCaseCommand,
} from '../data/input-cases.api';
import {
  inputCasesKey,
  inputCasesQueryOptions,
} from '../data/input-cases.queries';

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
  if (isUncertainOutcome(cause))
    return 'We couldn’t confirm this change. Retry the exact change within 24 hours; other changes are blocked until it is resolved.';
  return describeCommandError(cause, 'changing this input case');
}

function evictCases(cache: QueryClient, key: ReturnType<typeof inputCasesKey>) {
  void cache.cancelQueries({ queryKey: key });
  cache.removeQueries({ queryKey: key });
}

function useCaseOwner(
  api: ApiClient,
  cache: QueryClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  canWrite: boolean,
  onRetire: () => void,
) {
  const ownerRef = useRef<symbol | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const retainedRef = useRef<
    Readonly<{ command: InputCaseCommand; until: number }> | undefined
  >(undefined);
  const previousWrite = useRef(canWrite);
  const retire = useCallback(() => {
    ownerRef.current = undefined;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    retainedRef.current = undefined;
    onRetire();
    evictCases(cache, inputCasesKey(userId, workspaceId, workflowId));
  }, [cache, userId, workspaceId, workflowId, onRetire]);
  useEffect(() => {
    const token = Symbol('input-cases');
    ownerRef.current = token;
    const key = inputCasesKey(userId, workspaceId, workflowId);
    function disposeRequest() {
      controllerRef.current?.abort();
      retainedRef.current = undefined;
    }
    if (previousWrite.current && !canWrite) retire();
    previousWrite.current = canWrite;
    const unsubscribe = cache.getQueryCache().subscribe((event) => {
      if (ownerRef.current !== token || event.type !== 'updated') return;
      const scope = event.query.queryKey as readonly unknown[];
      if (
        scope[0] === 'identity' &&
        scope[1] === userId &&
        scope[2] === 'workspace' &&
        scope[3] === workspaceId &&
        denied(event.query.state.error)
      )
        retire();
    });
    return () => {
      unsubscribe();
      if (ownerRef.current === token) ownerRef.current = undefined;
      disposeRequest();
      evictCases(cache, key);
    };
  }, [api, userId, workspaceId, workflowId, cache, canWrite, retire]);
  return { ownerRef, controllerRef, retainedRef, retire };
}

/** Metadata in Query, opened payload and exact command only in this owner. */
export function useInputCases(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  canWrite: boolean,
) {
  const cache = useQueryClient();
  const query = useInfiniteQuery(
    inputCasesQueryOptions(api, userId, workspaceId, workflowId),
  );
  const [selected, setSelected] = useState<WorkflowInputCase>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const onRetire = useCallback(() => {
    setSelected(undefined);
    setUncertain(false);
    setConflict(false);
    setAccessLost(true);
    setPending(false);
  }, []);
  const { ownerRef, controllerRef, retainedRef, retire } = useCaseOwner(
    api,
    cache,
    userId,
    workspaceId,
    workflowId,
    canWrite,
    onRetire,
  );

  async function read(caseId: string) {
    if (pending || uncertain || accessLost) return undefined;
    const token = ownerRef.current;
    if (token === undefined) return undefined;
    const abort = new AbortController();
    controllerRef.current = abort;
    setPending(true);
    setError(undefined);
    try {
      const result = await getInputCase(
        api,
        workspaceId,
        workflowId,
        caseId,
        abort.signal,
      );
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
      if (ownerRef.current === token) setPending(false);
    }
  }

  async function send(command: InputCaseCommand, retry = false) {
    if (
      pending ||
      !canWrite ||
      accessLost ||
      (!retry && retainedRef.current !== undefined)
    )
      return false;
    const token = ownerRef.current;
    if (token === undefined) return false;
    const attempt = retry
      ? retainedRef.current
      : { command, until: Date.now() + 86_400_000 };
    if (attempt === undefined) return false;
    if (Date.now() >= attempt.until) {
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
      await assertSessionIdentity(api, userId, abort.signal);
      const workspace = (
        await getAllAccessibleWorkspaces(api, abort.signal)
      ).find((item) => item.id === workspaceId);
      if (ownerRef.current !== token) return false;
      if (
        workspace?.status !== 'active' ||
        !workspace.capabilities.includes('workflow:update')
      ) {
        retire();
        return false;
      }
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
        const unknown = isUncertainOutcome(cause);
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
      if (ownerRef.current === token) setPending(false);
    }
  }
  return {
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
        : send(retainedRef.current.command, true),
  };
}
