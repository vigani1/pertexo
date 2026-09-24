import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceRenameResponse } from '@pertexo/contracts/schemas/identity-workspace';
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
import {
  type WorkspaceRenameAttempt,
  workspaceRenameMutationOptions,
} from '../workspaces.mutations';

type RenameError = Readonly<{
  kind: 'conflict' | 'denied' | 'other' | 'verification';
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

export function useWorkspaceRename({
  apiClient,
  userId,
  workspaceId,
  onChanged,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  onChanged: () => void;
  onAccessLost: () => void;
}>) {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    workspaceRenameMutationOptions(apiClient, workspaceId),
  );
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

  async function clearInvalidIdentity(scope: symbol) {
    await queryClient.cancelQueries({ queryKey: ['identity'] });
    if (owner.current !== scope) return;
    queryClient.removeQueries({ queryKey: ['identity'] });
    transition({ kind: 'idle' });
    onAccessLost();
  }

  async function clearWorkspaceAccess(scope: symbol) {
    await queryClient.cancelQueries({
      queryKey: workspaceKeys.accessible(userId),
    });
    if (owner.current !== scope) return;
    queryClient.removeQueries({
      queryKey: workspaceKeys.accessible(userId),
    });
    transition({ kind: 'idle' });
    onAccessLost();
  }

  async function verify(scope: symbol, attempt: WorkspaceRenameAttempt) {
    try {
      await assertSessionIdentity(apiClient, userId);
      return owner.current === scope;
    } catch (error) {
      if (owner.current !== scope) return false;
      if (isSessionIdentityChangedError(error)) {
        await clearInvalidIdentity(scope);
        return false;
      }
      if (isSessionIdentityUnverifiedError(error)) {
        transition({
          kind: 'uncertain',
          attempt,
          error: {
            kind: 'verification',
            message:
              'Your session could not be verified. Retry preserves this exact rename command.',
          },
        });
        return false;
      }
      throw error;
    }
  }

  async function refresh(
    scope: symbol,
    attempt: WorkspaceRenameAttempt,
    receipt: WorkspaceRenameResponse,
  ) {
    transition({ kind: 'accepted', attempt, receipt, refreshing: true });
    try {
      const options = accessibleWorkspacesQueryOptions(apiClient, userId);
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.accessible(userId),
      });
      const workspaces = await queryClient.query(options);
      if (owner.current !== scope) return false;
      const discovered = workspaces.find(
        (workspace) => workspace.id === receipt.workspace.id,
      );
      if (
        discovered === undefined ||
        discovered.revision < receipt.workspace.revision
      ) {
        throw new Error('Renamed workspace is not visible in discovery');
      }
      transition({ kind: 'idle' });
      onChanged();
      return true;
    } catch {
      if (owner.current !== scope) return false;
      transition({
        kind: 'accepted',
        attempt,
        receipt,
        refreshing: false,
        error: {
          kind: 'other',
          message:
            'The name changed, but workspace access could not be refreshed. Refresh access without renaming again.',
        },
      });
      return false;
    }
  }

  async function execute(attempt: WorkspaceRenameAttempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    transition({ kind: 'executing', attempt });
    try {
      if (!(await verify(scope, attempt))) return false;
      let receipt: WorkspaceRenameResponse;
      try {
        receipt = await mutation.mutateAsync(attempt);
      } catch (error) {
        if (owner.current !== scope) return false;
        if (isUnauthenticated(error)) {
          await clearInvalidIdentity(scope);
          return false;
        }
        if (isApiError(error) && error.status === 403) {
          await clearWorkspaceAccess(scope);
          return false;
        }
        if (
          isApiError(error) &&
          (error.kind === 'network' ||
            error.kind === 'timeout' ||
            error.kind === 'protocol')
        ) {
          transition({
            kind: 'uncertain',
            attempt,
            error: {
              kind: 'other',
              message:
                'The rename result is uncertain. Retry sends the exact same name, revision and command key.',
            },
          });
          return false;
        }
        transition({ kind: 'idle', error: renameError(error) });
        return false;
      }
      if (owner.current !== scope) return false;
      return await refresh(scope, attempt, receipt);
    } finally {
      inFlight.current = false;
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
      const options = accessibleWorkspacesQueryOptions(apiClient, userId);
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.accessible(userId),
      });
      await queryClient.query(options);
      return owner.current === scope;
    } catch {
      if (owner.current === scope)
        transition({
          kind: 'idle',
          error: {
            kind: 'conflict',
            message:
              'The workspace changed, but the latest value could not be refreshed. Try refreshing again before reapplying.',
          },
        });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  return {
    accepted: state.kind === 'accepted',
    error:
      state.kind === 'idle' ||
      state.kind === 'uncertain' ||
      state.kind === 'accepted'
        ? state.error
        : undefined,
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
    refresh: async () => {
      const current = stateRef.current;
      const scope = owner.current;
      if (
        current.kind !== 'accepted' ||
        scope === undefined ||
        inFlight.current
      )
        return false;
      inFlight.current = true;
      try {
        return await refresh(scope, current.attempt, current.receipt);
      } finally {
        inFlight.current = false;
      }
    },
    clearError: () => {
      if (stateRef.current.kind === 'idle') transition({ kind: 'idle' });
    },
  };
}

function renameError(error: unknown): RenameError {
  if (isApiError(error)) {
    if (error.problem?.code === 'workspace.revision_conflict')
      return {
        kind: 'conflict',
        message:
          'The workspace changed since this form was loaded. Refresh it, review the latest name, then explicitly reapply your edit.',
      };
    if (error.problem?.code === 'request.idempotency_conflict')
      return {
        kind: 'other',
        message: 'This command key belongs to different rename details.',
      };
    if (error.problem?.code === 'workspace.conflict')
      return {
        kind: 'other',
        message: 'Only an active workspace can be renamed.',
      };
  }
  return { kind: 'other', message: 'The workspace name could not be changed.' };
}
