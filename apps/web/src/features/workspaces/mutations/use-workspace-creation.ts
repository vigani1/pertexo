import type {
  AccessibleWorkspace,
  WorkspaceCreateRequest,
  WorkspaceResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  mutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
  isSessionIdentityUnverifiedError,
  isUnauthenticated,
} from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  accessibleWorkspacesQueryOptions,
  workspaceKeys,
} from '../workspaces.queries';
import { createWorkspace } from '../workspaces.api';

type WorkspaceCreationAttempt = Readonly<{
  body: WorkspaceCreateRequest;
  idempotencyKey: string;
}>;

type CreationError = Readonly<{
  field?: 'slug';
  message: string;
}>;

type State =
  | Readonly<{ kind: 'idle'; error?: CreationError }>
  | Readonly<{ kind: 'executing'; attempt: WorkspaceCreationAttempt }>
  | Readonly<{
      kind: 'uncertain';
      attempt: WorkspaceCreationAttempt;
      error: CreationError;
    }>
  | Readonly<{
      kind: 'created';
      attempt: WorkspaceCreationAttempt;
      workspace: WorkspaceResponse;
      refreshing: boolean;
      error?: CreationError;
    }>;
type RecoveryState = Extract<State, { kind: 'uncertain' | 'created' }>;

export type WorkspaceCreationCommand = ReturnType<typeof useWorkspaceCreation>;

/**
 * The create request itself. The command owns the cache refresh: after
 * re-verifying the identity it invalidates and re-reads the accessible
 * workspaces (`refreshDiscovery`), so the mutation carries no cache effect.
 */
function creationMutation(apiClient: ApiClient) {
  return mutationOptions({
    mutationFn: (attempt: WorkspaceCreationAttempt) =>
      createWorkspace(apiClient, attempt),
  });
}

/** What the form reads from the command's state. */
function describeState(state: State) {
  return {
    created: state.kind === 'created',
    error:
      state.kind === 'idle' ||
      state.kind === 'uncertain' ||
      state.kind === 'created'
        ? state.error
        : undefined,
    locked: state.kind === 'executing' || state.kind === 'uncertain',
    pending: state.kind === 'executing',
    refreshPending: state.kind === 'created' && state.refreshing,
    retryAvailable: state.kind === 'uncertain',
  };
}

export function useWorkspaceCreation({
  apiClient,
  userId,
  onCreated,
  onSessionInvalidated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
}>) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateRef = useRef(state);
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const mutation = useMutation(creationMutation(apiClient));

  useEffect(() => {
    const scope = Symbol('workspace-creation');
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = undefined;
    };
  }, [apiClient, userId]);

  function transition(next: State) {
    stateRef.current = next;
    setState(next);
  }

  async function clearInvalidIdentity(scope: symbol) {
    await queryClient.cancelQueries({ queryKey: ['identity'] });
    if (owner.current !== scope) return;
    queryClient.removeQueries({ queryKey: ['identity'] });
    transition({ kind: 'idle' });
    onSessionInvalidated();
  }

  async function verifyIdentity(
    scope: symbol,
    recovery: RecoveryState,
  ): Promise<boolean> {
    try {
      await assertSessionIdentity(apiClient, userId);
      return owner.current === scope;
    } catch (error) {
      if (owner.current !== scope) return false;
      if (isSessionIdentityChangedError(error)) {
        await clearInvalidIdentity(scope);
        return false;
      }
      if (isSessionIdentityUnverifiedError(error) || isUnauthenticated(error)) {
        transition({
          ...recovery,
          error: {
            message:
              'We couldn’t confirm you’re still signed in. Check your connection, then try again.',
          },
        });
        return false;
      }
      throw error;
    }
  }

  async function refreshDiscovery(
    scope: symbol,
    attempt: WorkspaceCreationAttempt,
    workspace: WorkspaceResponse,
  ) {
    const recovery: State = {
      kind: 'created',
      attempt,
      workspace,
      refreshing: false,
      error: {
        message:
          'Your workspace was created, but we couldn’t open it yet. Try opening it again; nothing is created twice.',
      },
    };
    transition({ kind: 'created', attempt, workspace, refreshing: true });
    if (!(await verifyIdentity(scope, recovery))) return false;
    try {
      const options = accessibleWorkspacesQueryOptions(apiClient, userId);
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.accessible(userId),
      });
      const workspaces = await queryClient.query(options);
      if (owner.current !== scope) return false;
      const accessible = workspaces.find(
        (candidate) => candidate.id === workspace.id,
      );
      if (accessible === undefined) {
        transition(recovery);
        return false;
      }
      transition({ kind: 'idle' });
      onCreated(accessible);
      return true;
    } catch (error) {
      if (owner.current !== scope) return false;
      if (isUnauthenticated(error)) {
        await clearInvalidIdentity(scope);
        return false;
      }
      transition(recovery);
      return false;
    }
  }

  async function execute(attempt: WorkspaceCreationAttempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    transition({ kind: 'executing', attempt });
    try {
      const verificationRecovery: State = {
        kind: 'uncertain',
        attempt,
        error: {
          message:
            'We couldn’t confirm you’re still signed in. Check your connection, then check again.',
        },
      };
      if (!(await verifyIdentity(scope, verificationRecovery))) return false;

      let workspace: WorkspaceResponse;
      try {
        workspace = await mutation.mutateAsync(attempt);
      } catch (error) {
        if (owner.current !== scope) return false;
        if (isUnauthenticated(error)) {
          await clearInvalidIdentity(scope);
          return false;
        }
        if (isUncertain(error)) {
          transition({
            kind: 'uncertain',
            attempt,
            error: {
              message:
                'We’re not sure the workspace was created. Check again; it won’t create a second one.',
            },
          });
          return false;
        }
        transition({ kind: 'idle', error: creationError(error) });
        return false;
      }
      if (owner.current !== scope) return false;
      return await refreshDiscovery(scope, attempt, workspace);
    } finally {
      inFlight.current = false;
    }
  }

  return {
    ...describeState(state),
    start: (attempt: WorkspaceCreationAttempt) =>
      stateRef.current.kind === 'idle'
        ? execute(attempt)
        : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain'
        ? execute(current.attempt)
        : Promise.resolve(false);
    },
    refresh: async () => {
      const current = stateRef.current;
      const scope = owner.current;
      if (current.kind !== 'created' || scope === undefined || inFlight.current)
        return false;
      inFlight.current = true;
      try {
        return await refreshDiscovery(
          scope,
          current.attempt,
          current.workspace,
        );
      } finally {
        inFlight.current = false;
      }
    },
    dismissUncertain: () => {
      if (stateRef.current.kind === 'uncertain') transition({ kind: 'idle' });
    },
    clearError: () => {
      if (stateRef.current.kind === 'idle') transition({ kind: 'idle' });
    },
  };
}

function isUncertain(error: unknown) {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

function creationError(error: unknown): CreationError {
  if (isApiError(error)) {
    if (error.problem?.code === 'workspace.conflict')
      return {
        field: 'slug',
        message: 'That handle is already taken. Choose another one.',
      };
    if (error.problem?.code === 'request.idempotency_conflict')
      return {
        message:
          'These details changed since the last attempt. Start over to create the workspace.',
      };
    if (error.status === 403)
      return {
        message: 'Your account isn’t allowed to create workspaces.',
      };
    if (error.status === 400)
      return {
        message:
          'Pertexo didn’t accept these details. Check the name and handle.',
      };
  }
  return { message: 'The workspace couldn’t be created. Try again.' };
}
