import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useResendExpired } from '@/lib/api/commands/use-resend-window';
import type { WorkspaceMember } from '@pertexo/contracts';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/session/identity.public';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { workspaceKeys, workspaceMemberKeys } from '../../workspaces.queries';
import { directoryMembershipFeedback } from '../../../model/directory-membership';

/** Every member command names its target at the revision people saw. */
export type MemberCommandAttempt = Readonly<{
  member: WorkspaceMember;
  targetUserId: string;
  expectedRoleRevision: number;
}> &
  CommandKey;

/** A sentence about one member; `freshSignIn` offers signing in again. */
export type MemberCommandFeedback = Readonly<{
  targetUserId: string;
  message: string;
  freshSignIn?: boolean;
}>;

/** A command's feedback when it is about this member. */
export function feedbackFor(
  feedback: MemberCommandFeedback | undefined,
  member: WorkspaceMember | undefined,
): MemberCommandFeedback | undefined {
  return feedback?.targetUserId === member?.userId ? feedback : undefined;
}

type CommandState<Attempt> =
  | Readonly<{ kind: 'idle'; feedback?: MemberCommandFeedback }>
  | Readonly<{
      kind: 'executing';
      attempt: Attempt;
      phase: 'request' | 'reconciliation';
    }>
  | Readonly<{ kind: 'uncertain'; attempt: Attempt; message: string }>;

/** Idle, or holding a command whose retry window has ended. */
function canStart(state: CommandState<MemberCommandAttempt>): boolean {
  return (
    state.kind === 'idle' ||
    (state.kind === 'uncertain' && !canResend(state.attempt))
  );
}

/** The sentences a member command uses about its target. */
export type MemberCommandCopy = Readonly<{
  uncertain: (member: WorkspaceMember) => string;
  conflict: (member: WorkspaceMember) => string;
  /** How a failure names the action, e.g. "changing this role". */
  action: string;
}>;

/** The server wants a sign-in from the last few minutes (ADR 047). */
function needsFreshSignIn(cause: unknown): boolean {
  return isApiError(cause) && cause.problem?.code === 'auth.session_not_fresh';
}

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
type MemberCommandInput<Attempt extends MemberCommandAttempt> = Readonly<{
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
}>;

export function useMemberCommand<Attempt extends MemberCommandAttempt>(
  input: MemberCommandInput<Attempt>,
) {
  const queryClient = useQueryClient();
  const owner = useRef<symbol | undefined>(undefined);
  const inFlight = useRef(false);
  const [state, setState] = useState<CommandState<Attempt>>({ kind: 'idle' });
  const stateRef = useRef<CommandState<Attempt>>(state);
  const expired = useResendExpired(
    state.kind === 'uncertain' ? state.attempt : undefined,
  );
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

  const mutation = useMutation({
    mutationFn: ({ attempt }: Readonly<{ attempt: Attempt; scope: symbol }>) =>
      input.send(attempt),
    onSuccess: async (_result, { attempt, scope }) => {
      if (owner.current !== scope) return;
      transition({ kind: 'executing', attempt, phase: 'reconciliation' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: membersKey }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.accessible(input.actorUserId),
        }),
      ]);
    },
  });

  const context: MemberFailureContext<Attempt> = {
    input,
    queryClient,
    owner,
    transition,
    membersKey,
  };

  async function execute(attempt: Attempt) {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return false;
    inFlight.current = true;
    transition({ kind: 'executing', attempt, phase: 'request' });
    try {
      await mutation.mutateAsync({ attempt, scope });
      if (owner.current !== scope) return false;
      transition({ kind: 'idle' });
      input.onDone(attempt);
      return true;
    } catch (cause) {
      if (owner.current === scope)
        await settleMemberFailure<Attempt>(context, { scope, attempt, cause });
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
    error: expired
      ? RETRY_WINDOW_ENDED
      : state.kind === 'uncertain'
        ? state.message
        : undefined,
    feedback: state.kind === 'idle' ? state.feedback : undefined,
    locked:
      state.kind === 'executing' || (state.kind === 'uncertain' && !expired),
    pending: state.kind === 'executing',
    retryAvailable: state.kind === 'uncertain' && !expired,
    /** Sends a new command; nothing starts while another is unresolved. */
    start: (attempt: Attempt) =>
      canStart(stateRef.current) ? execute(attempt) : Promise.resolve(false),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain' && canResend(current.attempt)
        ? execute(current.attempt)
        : Promise.resolve(false);
    },
    /** Gives up on an unconfirmed command and reloads the real members. */
    dismiss: () => {
      if (stateRef.current.kind !== 'uncertain') return;
      transition({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
  };
}

type MemberFailureContext<Attempt extends MemberCommandAttempt> = Readonly<{
  input: MemberCommandInput<Attempt>;
  queryClient: QueryClient;
  owner: Readonly<{ current: symbol | undefined }>;
  transition: (state: CommandState<Attempt>) => void;
  membersKey: readonly unknown[];
}>;
async function settleMemberFailure<Attempt extends MemberCommandAttempt>(
  {
    input,
    queryClient,
    owner,
    transition,
    membersKey,
  }: MemberFailureContext<Attempt>,
  {
    scope,
    attempt,
    cause,
  }: Readonly<{ scope: symbol; attempt: Attempt; cause: unknown }>,
) {
  if (isUnconfirmedCommand(cause)) {
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
  if (needsFreshSignIn(cause)) {
    transition({
      kind: 'idle',
      feedback: {
        targetUserId: attempt.targetUserId,
        message:
          'For your security, sign in again, then confirm within five minutes.',
        freshSignIn: true,
      },
    });
    return;
  }
  const directoryFeedback = directoryMembershipFeedback(cause);
  if (directoryFeedback !== undefined) {
    await queryClient.invalidateQueries({ queryKey: membersKey });
    if (owner.current !== scope) return;
    transition({
      kind: 'idle',
      feedback: {
        targetUserId: attempt.targetUserId,
        message: directoryFeedback,
      },
    });
    input.onConflict();
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
