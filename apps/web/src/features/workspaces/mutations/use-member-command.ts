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
import { workspaceKeys, workspaceMemberKeys } from '../workspaces.queries';

/** Every member command names its target at the revision people saw. */
export type MemberCommandAttempt = Readonly<{
  member: WorkspaceMember;
  targetUserId: string;
  expectedRoleRevision: number;
  idempotencyKey: string;
}>;

type CommandState<Attempt> =
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

/** The sentences a member command uses about its target. */
export type MemberCommandCopy = Readonly<{
  uncertain: (member: WorkspaceMember) => string;
  conflict: (member: WorkspaceMember) => string;
  /** How a failure names the action, e.g. "changing this role". */
  action: string;
}>;

/** A target that no longer exists or is no longer in the workspace. */
function isTargetGone(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    (cause.status === 404 ||
      cause.problem?.code === 'workspace.member_removal_conflict')
  );
}

/**
 * One existing-member command at the revision the confirmation showed. An
 * unconfirmed command keeps its exact attempt for a retry; a stale revision
 * refreshes the list and asks for a new decision.
 */
export function useMemberCommand<Attempt extends MemberCommandAttempt>(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    send: (attempt: Attempt) => Promise<unknown>;
    copy: MemberCommandCopy;
    onDone: (attempt: Attempt) => void;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: (member: WorkspaceMember) => void;
  }>,
) {
  const queryClient = useQueryClient();
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const [state, setState] = useState<CommandState<Attempt>>({ kind: 'idle' });
  const stateRef = useRef<CommandState<Attempt>>(state);
  const mutation = useMutation({ mutationFn: input.send });
  const membersKey = workspaceMemberKeys.list(
    input.actorUserId,
    input.workspaceId,
  );

  useEffect(() => {
    const scope = Symbol('member-command');
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = undefined;
    };
  }, [input.apiClient, input.actorUserId, input.workspaceId]);

  const transition = useCallback((next: CommandState<Attempt>) => {
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
        message: input.copy.uncertain(attempt.member),
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
      transition(
        isTargetGone(cause)
          ? { kind: 'idle' }
          : {
              kind: 'idle',
              feedback: {
                targetUserId: attempt.targetUserId,
                message: input.copy.conflict(attempt.member),
              },
            },
      );
      if (isTargetGone(cause)) input.onTargetUnavailable(attempt.member);
      else input.onConflict();
      return;
    }
    transition({
      kind: 'idle',
      feedback: {
        targetUserId: attempt.targetUserId,
        message: describeCommandError(cause, input.copy.action),
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
          queryKey: workspaceKeys.accessible(input.actorUserId),
        }),
      ]);
      if (owner.current !== scope) return false;
      transition({ kind: 'idle' });
      input.onDone(attempt);
      return true;
    } catch (cause) {
      if (owner.current === scope) await settleFailure(scope, attempt, cause);
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  return {
    activeAttempt:
      state.kind === 'executing' || state.kind === 'uncertain'
        ? state.attempt
        : undefined,
    error: state.kind === 'uncertain' ? state.message : undefined,
    feedback: state.kind === 'idle' ? state.feedback : undefined,
    locked: state.kind !== 'idle',
    pending: state.kind === 'executing',
    retryAvailable: state.kind === 'uncertain',
    /** Sends a new command; nothing starts while another is unresolved. */
    start: (attempt: Attempt) =>
      stateRef.current.kind === 'idle'
        ? execute(attempt)
        : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind !== 'uncertain'
        ? Promise.resolve(false)
        : execute(current.attempt);
    },
    /** Gives up on an unconfirmed command and reloads the real members. */
    dismiss: () => {
      if (stateRef.current.kind !== 'uncertain') return;
      transition({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
  };
}
