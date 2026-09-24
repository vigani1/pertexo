import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type {
  WorkspaceRenameRequest,
  WorkspaceRenameResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
  isSessionIdentityUnverifiedError,
  isUnauthenticated,
} from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  accessibleWorkspacesQueryOptions,
  workspaceKeys,
} from '../workspaces.queries';
import { renameWorkspace } from '../workspaces.api';

type WorkspaceRenameAttempt = Readonly<{
  body: WorkspaceRenameRequest;
  idempotencyKey: string;
}>;

type RenameError = Readonly<{
  kind: 'conflict' | 'other' | 'verification';
  message: string;
}>;
type State =
  | Readonly<{ kind: 'idle'; error?: RenameError }>
  | Readonly<{ kind: 'executing'; attempt: WorkspaceRenameAttempt }>
  | Readonly<{
      kind: 'uncertain';
      attempt: WorkspaceRenameAttempt;
      error: RenameError;
    }>
  | Readonly<{
      kind: 'accepted';
      attempt: WorkspaceRenameAttempt;
      receipt: WorkspaceRenameResponse;
      refreshing: boolean;
      error?: RenameError;
    }>;
type Failure =
  | Readonly<{ kind: 'signed-out' }>
  | Readonly<{ kind: 'forbidden' }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'rejected'; error: RenameError }>;

const CONFLICT: RenameError = {
  kind: 'conflict',
  message: 'This workspace changed while you were editing.',
};
const UNCERTAIN: RenameError = {
  kind: 'other',
  message:
    'We couldn’t confirm whether the rename went through. Try again — it can’t apply twice.',
};
const UNVERIFIED: RenameError = {
  kind: 'verification',
  message:
    'We couldn’t check your session. Try again — the same rename is kept.',
};
const NOT_CAUGHT_UP: RenameError = {
  kind: 'other',
  message:
    'The new name is saved, but this page couldn’t catch up. Refresh to see it everywhere.',
};
const RELOAD_FAILED: RenameError = {
  kind: 'conflict',
  message:
    'Someone changed this workspace meanwhile, and the latest name couldn’t be loaded. Try again.',
};

function classifyFailure(error: unknown): Failure {
  if (isUnauthenticated(error)) return { kind: 'signed-out' };
  if (isApiError(error) && error.status === 403) return { kind: 'forbidden' };
  if (isUncertainOutcome(error)) return { kind: 'uncertain' };
  const code = isApiError(error) ? error.problem?.code : undefined;
  if (code === 'workspace.revision_conflict')
    return { kind: 'rejected', error: CONFLICT };
  if (code === 'request.idempotency_conflict')
    return {
      kind: 'rejected',
      error: {
        kind: 'other',
        message:
          'This request was already used with different details. Try again.',
      },
    };
  if (code === 'workspace.conflict')
    return {
      kind: 'rejected',
      error: {
        kind: 'other',
        message: 'Only an active workspace can be renamed.',
      },
    };
  return {
    kind: 'rejected',
    error: {
      kind: 'other',
      message: describeCommandError(error, 'renaming the workspace'),
    },
  };
}

/** Whether the signed-in person is still the one who started the rename. */
async function checkSession(
  apiClient: ApiClient,
  userId: string,
): Promise<'same' | 'changed' | 'unverified'> {
  try {
    await assertSessionIdentity(apiClient, userId);
    return 'same';
  } catch (error) {
    if (isSessionIdentityChangedError(error)) return 'changed';
    if (isSessionIdentityUnverifiedError(error)) return 'unverified';
    throw error;
  }
}

/**
 * The rename request itself. The command owns the cache refresh: after
 * re-verifying the identity it re-reads discovery until it shows the new
 * revision (`catchUpDiscovery`), so the mutation carries no cache effect.
 */
function renameMutation(apiClient: ApiClient, workspaceId: string) {
  return mutationOptions({
    mutationFn: (attempt: WorkspaceRenameAttempt) =>
      renameWorkspace(apiClient, workspaceId, attempt),
  });
}

/** Reloads workspace discovery until it shows at least the renamed revision. */
async function catchUpDiscovery(
  queryClient: QueryClient,
  apiClient: ApiClient,
  userId: string,
  receipt: WorkspaceRenameResponse,
) {
  await queryClient.invalidateQueries({
    queryKey: workspaceKeys.accessible(userId),
  });
  const workspaces = await queryClient.query(
    accessibleWorkspacesQueryOptions(apiClient, userId),
  );
  const discovered = workspaces.find(
    (workspace) => workspace.id === receipt.workspace.id,
  );
  return (
    discovered !== undefined &&
    discovered.revision >= receipt.workspace.revision
  );
}

/**
 * Renames the workspace at the revision the form started from. An
 * unconfirmed rename keeps its exact command; a conflict loads the latest
 * workspace so people choose between their name and the newer one.
 */
export function useWorkspaceRename({
  apiClient,
  userId,
  workspaceId,
  onChanged,
  onReloaded,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  onChanged: (name: string) => void;
  onReloaded: () => void;
  onAccessLost: () => void;
}>) {
  const queryClient = useQueryClient();
  const mutation = useMutation(renameMutation(apiClient, workspaceId));
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateRef = useRef(state);
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);

  useEffect(() => {
    const scope = Symbol('workspace-rename');
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = undefined;
    };
  }, [apiClient, userId, workspaceId]);

  function transition(next: State) {
    stateRef.current = next;
    setState(next);
  }

  async function loseAccess(scope: symbol, queryKey: readonly unknown[]) {
    await queryClient.cancelQueries({ queryKey });
    if (owner.current !== scope) return;
    queryClient.removeQueries({ queryKey });
    transition({ kind: 'idle' });
    onAccessLost();
  }

  async function refresh(
    scope: symbol,
    attempt: WorkspaceRenameAttempt,
    receipt: WorkspaceRenameResponse,
  ) {
    transition({ kind: 'accepted', attempt, receipt, refreshing: true });
    const caughtUp = await catchUpDiscovery(
      queryClient,
      apiClient,
      userId,
      receipt,
    ).catch(() => false);
    if (owner.current !== scope) return false;
    if (!caughtUp) {
      transition({
        kind: 'accepted',
        attempt,
        receipt,
        refreshing: false,
        error: NOT_CAUGHT_UP,
      });
      return false;
    }
    transition({ kind: 'idle' });
    onChanged(receipt.workspace.name);
    return true;
  }

  /** Sends the rename; on failure settles the state and says whether it conflicted. */
  async function send(scope: symbol, attempt: WorkspaceRenameAttempt) {
    try {
      return { receipt: await mutation.mutateAsync(attempt), conflict: false };
    } catch (error) {
      const failure = classifyFailure(error);
      if (owner.current !== scope)
        return { receipt: undefined, conflict: false };
      if (failure.kind === 'signed-out') await loseAccess(scope, ['identity']);
      else if (failure.kind === 'forbidden')
        await loseAccess(scope, workspaceKeys.accessible(userId));
      else if (failure.kind === 'uncertain')
        transition({ kind: 'uncertain', attempt, error: UNCERTAIN });
      else transition({ kind: 'idle', error: failure.error });
      return {
        receipt: undefined,
        conflict: failure.kind === 'rejected' && failure.error === CONFLICT,
      };
    }
  }

  async function execute(attempt: WorkspaceRenameAttempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    let conflicted = false;
    try {
      transition({ kind: 'executing', attempt });
      const session = await checkSession(apiClient, userId);
      if (owner.current !== scope) return false;
      if (session === 'changed') {
        await loseAccess(scope, ['identity']);
        return false;
      }
      if (session === 'unverified') {
        transition({ kind: 'uncertain', attempt, error: UNVERIFIED });
        return false;
      }
      const sent = await send(scope, attempt);
      conflicted = sent.conflict;
      if (sent.receipt === undefined || owner.current !== scope) return false;
      return await refresh(scope, attempt, sent.receipt);
    } finally {
      inFlight.current = false;
      if (conflicted) void reloadLatest();
    }
  }

  async function reloadLatest() {
    const current = stateRef.current;
    const scope = owner.current;
    if (
      current.kind !== 'idle' ||
      current.error?.kind !== 'conflict' ||
      scope === undefined ||
      inFlight.current
    )
      return false;
    inFlight.current = true;
    try {
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.accessible(userId),
      });
      await queryClient.query(
        accessibleWorkspacesQueryOptions(apiClient, userId),
      );
      if (owner.current !== scope) return false;
      transition({ kind: 'idle', error: CONFLICT });
      onReloaded();
      return true;
    } catch {
      if (owner.current === scope)
        transition({ kind: 'idle', error: RELOAD_FAILED });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  async function refreshAccepted() {
    const current = stateRef.current;
    const scope = owner.current;
    if (current.kind !== 'accepted' || scope === undefined || inFlight.current)
      return false;
    inFlight.current = true;
    try {
      return await refresh(scope, current.attempt, current.receipt);
    } finally {
      inFlight.current = false;
    }
  }

  return {
    accepted: state.kind === 'accepted',
    error: state.kind === 'executing' ? undefined : state.error,
    pending: state.kind === 'executing',
    retryAvailable: state.kind === 'uncertain',
    reloadLatest,
    refreshPending: state.kind === 'accepted' && state.refreshing,
    start: (attempt: WorkspaceRenameAttempt) =>
      stateRef.current.kind === 'idle'
        ? execute(attempt)
        : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain'
        ? execute(current.attempt)
        : Promise.resolve(false);
    },
    dismiss: () => {
      if (stateRef.current.kind === 'uncertain') transition({ kind: 'idle' });
    },
    refresh: refreshAccepted,
    clearError: () => {
      if (stateRef.current.kind === 'idle') transition({ kind: 'idle' });
    },
  };
}
