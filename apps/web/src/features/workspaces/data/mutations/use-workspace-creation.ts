import {
  isUncertain,
  creationError,
  type CreationError,
} from '../../model/creation-feedback';
import type {
  AccessibleWorkspace,
  WorkspaceCreateRequest,
  WorkspaceResponse,
} from '@pertexo/contracts';
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
  isSessionIdentityUnverifiedError,
  isUnauthenticated,
} from '@/features/auth/session/identity.public';
import type { ApiClient } from '@/lib/api/client';
import {
  RETRY_WINDOW_ENDED,
  canResend,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useResendExpired } from '@/lib/api/commands/use-resend-window';
import {
  accessibleWorkspacesQueryOptions,
  workspaceKeys,
} from '../workspaces.queries';
import { createWorkspace } from '../workspaces.api';

type WorkspaceCreationAttempt = Readonly<{ body: WorkspaceCreateRequest }> &
  CommandKey;

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

/** Idle, or holding a creation whose retry window has ended. */
function canStart(state: State): boolean {
  return (
    state.kind === 'idle' ||
    (state.kind === 'uncertain' && !canResend(state.attempt))
  );
}

/** What the form reads from the command's state. */
function describeState(state: State, expired: boolean) {
  const held = state.kind === 'uncertain' && !expired;
  const stateError = state.kind === 'executing' ? undefined : state.error;
  return {
    created: state.kind === 'created',
    error: expired ? { message: RETRY_WINDOW_ENDED } : stateError,
    locked: state.kind === 'executing' || held,
    pending: state.kind === 'executing',
    refreshPending: state.kind === 'created' && state.refreshing,
    retryAvailable: held,
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
  const expired = useResendExpired(
    state.kind === 'uncertain' ? state.attempt : undefined,
  );

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

  const context: CreationContext = {
    queryClient,
    apiClient,
    userId,
    owner,
    transition,
    onCreated,
    onSessionInvalidated,
  };

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
      if (!(await verifyCreationIdentity(context, scope, verificationRecovery)))
        return false;

      let workspace: WorkspaceResponse;
      try {
        workspace = await mutation.mutateAsync(attempt);
      } catch (error) {
        if (owner.current !== scope) return false;
        if (isUnauthenticated(error)) {
          await clearCreationIdentity(context, scope);
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
      return await refreshCreationDiscovery(context, {
        scope,
        attempt,
        workspace,
      });
    } finally {
      inFlight.current = false;
    }
  }

  return {
    ...describeState(state, expired),
    start: (attempt: WorkspaceCreationAttempt) =>
      canStart(stateRef.current) ? execute(attempt) : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain' && canResend(current.attempt)
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
        return await refreshCreationDiscovery(context, {
          scope,
          attempt: current.attempt,
          workspace: current.workspace,
        });
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

type CreationContext = Readonly<{
  queryClient: QueryClient;
  apiClient: ApiClient;
  userId: string;
  owner: Readonly<{ current: symbol | undefined }>;
  transition: (state: State) => void;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
}>;
async function clearCreationIdentity(
  { queryClient, owner, transition, onSessionInvalidated }: CreationContext,
  scope: symbol,
) {
  await queryClient.cancelQueries({ queryKey: ['identity'] });
  if (owner.current !== scope) return;
  queryClient.removeQueries({ queryKey: ['identity'] });
  transition({ kind: 'idle' });
  onSessionInvalidated();
}

async function verifyCreationIdentity(
  context: CreationContext,
  scope: symbol,
  recovery: RecoveryState,
): Promise<boolean> {
  const { apiClient, userId, owner, transition } = context;
  try {
    await assertSessionIdentity(apiClient, userId);
    return owner.current === scope;
  } catch (error) {
    if (owner.current !== scope) return false;
    if (isSessionIdentityChangedError(error)) {
      await clearCreationIdentity(context, scope);
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

async function refreshCreationDiscovery(
  context: CreationContext,
  {
    scope,
    attempt,
    workspace,
  }: Readonly<{
    scope: symbol;
    attempt: WorkspaceCreationAttempt;
    workspace: WorkspaceResponse;
  }>,
) {
  const { queryClient, apiClient, userId, owner, transition, onCreated } =
    context;
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
  if (!(await verifyCreationIdentity(context, scope, recovery))) return false;
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
      await clearCreationIdentity(context, scope);
      return false;
    }
    transition(recovery);
    return false;
  }
}
