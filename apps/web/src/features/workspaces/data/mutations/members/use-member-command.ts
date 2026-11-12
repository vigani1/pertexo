import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { WorkspaceMember } from '@pertexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { workspaceKeys, workspaceMemberKeys } from '../../workspaces.queries';
import { directoryMembershipFeedback } from '../../../model/directory-membership';

export type MemberCommandAttempt = Readonly<{
  member: WorkspaceMember;
  targetUserId: string;
  expectedRoleRevision: number;
}>;
export type MemberCommandFeedback = Readonly<{
  targetUserId: string;
  message: string;
  freshSignIn?: boolean;
}>;
export function feedbackFor(
  feedback: MemberCommandFeedback | undefined,
  member: WorkspaceMember | undefined,
) {
  return feedback?.targetUserId === member?.userId ? feedback : undefined;
}
/** The sentences a member command uses about its target. */
export type MemberCommandCopy = Readonly<{
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
 * unconfirmed change refreshes the list and leaves a new decision to the user.
 */
type MemberCommandInput<Attempt extends MemberCommandAttempt> = Readonly<{
  apiClient: ApiClient;
  actorUserId: string;
  workspaceId: string;
  send: (
    attempt: Attempt & Readonly<{ idempotencyKey: string }>,
  ) => Promise<unknown>;
  copy: MemberCommandCopy;
  onDone: (attempt: Attempt) => void;
  onConflict: () => void;
  onTargetUnavailable: (member: WorkspaceMember) => void;
}>;

export function useMemberCommand<Attempt extends MemberCommandAttempt>(
  input: MemberCommandInput<Attempt>,
) {
  const cache = useQueryClient();
  const [feedback, setFeedback] = useState<MemberCommandFeedback>();
  const mutation = useLowEffectMutation({
    send: (attempt: Attempt, key) =>
      input.send({ ...attempt, idempotencyKey: key }),
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: workspaceMemberKeys.list(
            input.actorUserId,
            input.workspaceId,
          ),
        }),
        cache.invalidateQueries({
          queryKey: workspaceKeys.accessible(input.actorUserId),
        }),
      ]),
  });
  async function start(attempt: Attempt) {
    if (mutation.isPending) return false;
    setFeedback(undefined);
    try {
      await mutation.mutateAsync(attempt, {
        onSuccess: () => {
          input.onDone(attempt);
        },
      });
      return true;
    } catch (cause) {
      if (needsFreshSignIn(cause))
        setFeedback({
          targetUserId: attempt.targetUserId,
          message:
            'For your security, sign in again, then confirm within five minutes.',
          freshSignIn: true,
        });
      else if (isTargetGone(cause)) input.onTargetUnavailable(attempt.member);
      else {
        const directory = directoryMembershipFeedback(cause);
        const recoveryOwner =
          isApiError(cause) &&
          cause.problem?.code === 'workspace.recovery_owner_ineligible';
        const conflict = isApiError(cause) && cause.status === 409;
        let message = directory ?? lowEffectError(cause, input.copy.action);
        if (directory === undefined) {
          if (recoveryOwner && isApiError(cause))
            message =
              cause.problem.detail ??
              'Ask the new owner to prepare a recovery account, then retry.';
          else if (conflict) message = input.copy.conflict(attempt.member);
        }
        setFeedback({ targetUserId: attempt.targetUserId, message });
        if (directory !== undefined || conflict || recoveryOwner)
          input.onConflict();
      }
      return false;
    }
  }
  return {
    activeAttempt: mutation.isPending ? mutation.variables : undefined,
    feedback,
    pending: mutation.isPending,
    locked: mutation.isPending,
    start,
    dismiss: () => {
      setFeedback(undefined);
      mutation.reset();
    },
  };
}
