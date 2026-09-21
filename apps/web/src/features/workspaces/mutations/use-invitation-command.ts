import type { WorkspaceInvitation } from '@pertexo/contracts/schemas/identity-workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  changeWorkspaceInvitation,
  createWorkspaceInvitation,
} from '../workspaces.api';
import { workspaceInvitationKeys } from '../workspaces.queries';

type ManagedRole = 'admin' | 'builder' | 'operator' | 'viewer';
type Attempt =
  | Readonly<{
      kind: 'create';
      email: string;
      role: ManagedRole;
      idempotencyKey: string;
    }>
  | Readonly<{
      kind: 'resend' | 'revoke';
      invitation: WorkspaceInvitation;
      expectedRevision: number;
      idempotencyKey: string;
    }>;
type State =
  | Readonly<{ kind: 'idle'; message?: string }>
  | Readonly<{ kind: 'executing'; attempt: Attempt }>
  | Readonly<{ kind: 'uncertain'; attempt: Attempt; message: string }>;

export function useInvitationCommand(
  input: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
  }>,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateRef = useRef(state);
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const mutation = useMutation({ mutationFn: executeRequest });

  useEffect(() => {
    const scope = Symbol('invitation-command');
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = undefined;
    };
  }, [input.apiClient, input.userId, input.workspaceId]);

  const transition = useCallback((next: State) => {
    stateRef.current = next;
    setState(next);
  }, []);

  async function execute(attempt: Attempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    transition({ kind: 'executing', attempt });
    try {
      await mutation.mutateAsync(attempt);
      if (owner.current !== scope) return false;
      await queryClient.invalidateQueries({
        queryKey: workspaceInvitationKeys.list(input.userId, input.workspaceId),
      });
      if (owner.current !== scope) return false;
      transition({ kind: 'idle' });
      return true;
    } catch (error) {
      if (owner.current !== scope) return false;
      if (isUncertain(error)) {
        transition({
          kind: 'uncertain',
          attempt,
          message:
            'The result is uncertain. Retry sends the exact original command and key.',
        });
        return false;
      }
      if (isUnauthenticated(error)) {
        transition({ kind: 'idle' });
        input.onAuthenticationLost();
        return false;
      }
      if (isApiError(error) && (error.status === 403 || error.status === 404)) {
        transition({ kind: 'idle' });
        input.onPermissionLost();
        return false;
      }
      if (isApiError(error) && error.status === 409)
        await queryClient.invalidateQueries({
          queryKey: workspaceInvitationKeys.list(
            input.userId,
            input.workspaceId,
          ),
        });
      if (owner.current !== scope) return false;
      transition({ kind: 'idle', message: commandError(error) });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  function executeRequest(attempt: Attempt) {
    return attempt.kind === 'create'
      ? createWorkspaceInvitation(input.apiClient, input.workspaceId, attempt)
      : changeWorkspaceInvitation(
          input.apiClient,
          input.workspaceId,
          attempt.invitation.id,
          attempt.kind,
          attempt,
        );
  }

  const activeAttempt =
    state.kind === 'executing' || state.kind === 'uncertain'
      ? state.attempt
      : undefined;
  return {
    activeAttempt,
    locked: state.kind !== 'idle',
    pending: state.kind === 'executing',
    retryAvailable: state.kind === 'uncertain',
    message:
      state.kind === 'uncertain' || state.kind === 'idle'
        ? state.message
        : undefined,
    create: (email: string, role: ManagedRole) =>
      stateRef.current.kind === 'idle'
        ? execute({
            kind: 'create',
            email,
            role,
            idempotencyKey: crypto.randomUUID(),
          })
        : Promise.resolve(false),
    change: (invitation: WorkspaceInvitation, kind: 'resend' | 'revoke') =>
      stateRef.current.kind === 'idle'
        ? execute({
            kind,
            invitation,
            expectedRevision: invitation.revision,
            idempotencyKey: crypto.randomUUID(),
          })
        : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain'
        ? execute(current.attempt)
        : Promise.resolve(false);
    },
    dismiss: () => {
      transition({ kind: 'idle' });
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

function commandError(error: unknown) {
  if (
    isApiError(error) &&
    error.problem?.code === 'workspace.invitation_delivery_unavailable'
  )
    return 'The prior delivery outcome is still unknown. Reconcile that attempt before resending; its evidence was preserved.';
  if (isApiError(error) && error.status === 409)
    return 'The invitation changed or a pending invitation already exists. Review the refreshed list.';
  return 'The invitation command could not be completed. Try again.';
}
