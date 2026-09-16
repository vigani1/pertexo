import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { changeWorkspaceMemberRole } from '../workspaces.api';
import { workspaceMemberKeys } from '../workspaces.queries';

type ManagedRole = 'admin' | 'builder' | 'operator' | 'viewer';
type Attempt = Readonly<{
  member: WorkspaceMember;
  targetUserId: string;
  role: ManagedRole;
  expectedRoleRevision: number;
  idempotencyKey: string;
}>;
type CommandState =
  | Readonly<{
      kind: 'idle';
      feedback?: Readonly<{ targetUserId: string; message: string }>;
    }>
  | Readonly<{
      kind: 'executing';
      attempt: Attempt;
      phase: 'request' | 'reconciliation';
    }>
  | Readonly<{ kind: 'uncertain'; attempt: Attempt; message: string }>;

export function useMemberRoleCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: () => void;
  }>,
) {
  const queryClient = useQueryClient();
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const stateRef = useRef<CommandState>(state);
  const mutation = useMutation({
    mutationFn: (attempt: Attempt) =>
      changeWorkspaceMemberRole(
        input.apiClient,
        input.workspaceId,
        attempt.targetUserId,
        attempt,
      ),
  });

  useEffect(() => {
    const scope = Symbol('member-role-command');
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = undefined;
    };
  }, [input.apiClient, input.actorUserId, input.workspaceId]);

  const transition = useCallback((next: CommandState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  async function execute(attempt: Attempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    transition({ kind: 'executing', attempt, phase: 'request' });
    try {
      await mutation.mutateAsync(attempt);
      if (owner.current !== scope) return false;
      transition({ kind: 'executing', attempt, phase: 'reconciliation' });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceMemberKeys.list(
            input.actorUserId,
            input.workspaceId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: ['identity', input.actorUserId, 'accessible-workspaces'],
        }),
      ]);
      if (owner.current !== scope) return false;
      transition({ kind: 'idle' });
      return true;
    } catch (cause) {
      if (owner.current !== scope) return false;
      const uncertain = isUncertain(cause);
      if (uncertain) {
        transition({
          kind: 'uncertain',
          attempt,
          message: roleCommandError(cause),
        });
        return false;
      }
      if (isUnauthenticated(cause)) {
        transition({ kind: 'idle' });
        input.onAuthenticationLost();
        return false;
      }
      if (isApiError(cause) && cause.status === 403) {
        transition({ kind: 'idle' });
        input.onPermissionLost();
        return false;
      }
      if (isApiError(cause) && cause.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: workspaceMemberKeys.list(
            input.actorUserId,
            input.workspaceId,
          ),
        });
        if (owner.current !== scope) return false;
        transition({
          kind: 'idle',
          feedback: {
            targetUserId: attempt.targetUserId,
            message: roleCommandError(cause),
          },
        });
        input.onConflict();
        return false;
      }
      if (isApiError(cause) && cause.status === 404) {
        await queryClient.invalidateQueries({
          queryKey: workspaceMemberKeys.list(
            input.actorUserId,
            input.workspaceId,
          ),
        });
        if (owner.current !== scope) return false;
        transition({ kind: 'idle' });
        input.onTargetUnavailable();
        return false;
      }
      transition({
        kind: 'idle',
        feedback: {
          targetUserId: attempt.targetUserId,
          message: roleCommandError(cause),
        },
      });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  const activeAttempt =
    state.kind === 'executing' || state.kind === 'uncertain'
      ? state.attempt
      : undefined;

  return {
    activeMember: activeAttempt?.member,
    error:
      state.kind === 'uncertain'
        ? state.message
        : state.kind === 'idle'
          ? state.feedback?.message
          : undefined,
    errorTargetUserId:
      state.kind === 'uncertain'
        ? state.attempt.targetUserId
        : state.kind === 'idle'
          ? state.feedback?.targetUserId
          : undefined,
    locked: state.kind !== 'idle',
    pending: state.kind === 'executing',
    retryAvailable: state.kind === 'uncertain',
    start: (member: WorkspaceMember, role: ManagedRole) => {
      if (stateRef.current.kind !== 'idle') return Promise.resolve(false);
      return execute({
        member,
        targetUserId: member.userId,
        role,
        expectedRoleRevision: member.roleRevision,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    retry: () => {
      const current = stateRef.current;
      return current.kind !== 'uncertain'
        ? Promise.resolve(false)
        : execute(current.attempt);
    },
    dismiss: () => {
      if (stateRef.current.kind === 'uncertain') transition({ kind: 'idle' });
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

function roleCommandError(error: unknown): string {
  if (isUncertain(error))
    return 'The result is uncertain. Retry with the same role, revision, and command key.';
  if (isApiError(error) && error.status === 409)
    return 'This member changed since you opened the dialog. Review the refreshed role and confirm a new change.';
  if (isApiError(error) && (error.status === 403 || error.status === 404))
    return 'This role change is no longer available.';
  return 'The member role could not be changed. Try again.';
}
