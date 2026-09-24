import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import type { ManagedRole } from '../model/workspace-roles';
import { changeWorkspaceMemberRole } from '../workspaces.api';
import { workspaceMemberKeys } from '../workspaces.queries';

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

/**
 * Changes one member's role at the revision the confirmation showed. An
 * unconfirmed change keeps its exact command for a retry; a stale revision
 * refreshes the list and asks for a new decision.
 */
export function useMemberRoleCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onChanged: (member: WorkspaceMember, role: ManagedRole) => void;
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
  const membersKey = workspaceMemberKeys.list(
    input.actorUserId,
    input.workspaceId,
  );

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

  async function settleFailure(
    scope: symbol,
    attempt: Attempt,
    cause: unknown,
  ) {
    if (isUncertainOutcome(cause)) {
      transition({
        kind: 'uncertain',
        attempt,
        message: `We couldn’t confirm whether ${attempt.member.displayName}’s role changed. Try again — Pertexo recognises the repeat, so it can’t change twice.`,
      });
      return;
    }
    if (isUnauthenticated(cause)) {
      transition({ kind: 'idle' });
      input.onAuthenticationLost();
      return;
    }
    if (isApiError(cause) && cause.status === 403) {
      transition({ kind: 'idle' });
      input.onPermissionLost();
      return;
    }
    if (isApiError(cause) && (cause.status === 409 || cause.status === 404)) {
      await queryClient.invalidateQueries({ queryKey: membersKey });
      if (owner.current !== scope) return;
      if (cause.status === 404) {
        transition({ kind: 'idle' });
        input.onTargetUnavailable();
        return;
      }
      transition({
        kind: 'idle',
        feedback: {
          targetUserId: attempt.targetUserId,
          message: `${attempt.member.displayName}’s role changed while you were deciding. Choose again if you still want to change it.`,
        },
      });
      input.onConflict();
      return;
    }
    transition({
      kind: 'idle',
      feedback: {
        targetUserId: attempt.targetUserId,
        message: describeCommandError(cause, 'changing this role'),
      },
    });
  }

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
        queryClient.invalidateQueries({ queryKey: membersKey }),
        queryClient.invalidateQueries({
          queryKey: ['identity', input.actorUserId, 'accessible-workspaces'],
        }),
      ]);
      if (owner.current !== scope) return false;
      transition({ kind: 'idle' });
      input.onChanged(attempt.member, attempt.role);
      return true;
    } catch (cause) {
      if (owner.current === scope) await settleFailure(scope, attempt, cause);
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
    activeRole: activeAttempt?.role,
    error: state.kind === 'uncertain' ? state.message : undefined,
    feedback: state.kind === 'idle' ? state.feedback : undefined,
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
    /** Gives up on an unconfirmed change and reloads the members' real roles. */
    dismiss: () => {
      if (stateRef.current.kind !== 'uncertain') return;
      transition({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
  };
}
