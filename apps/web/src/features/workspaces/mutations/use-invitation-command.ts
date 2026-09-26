import type { WorkspaceInvitation } from '@pertexo/contracts/schemas/identity-workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { ManagedRole } from '../model/workspace-roles';
import {
  changeWorkspaceInvitation,
  createWorkspaceInvitation,
} from '../workspaces.api';
import { workspaceInvitationKeys } from '../workspaces.queries';

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

/** How one invitation command ended, for per-address results. */
export type InvitationOutcome =
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'uncertain'; message: string }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'stopped' }>;

export type InvitationCommand = ReturnType<typeof useInvitationCommand>;

const STOPPED: InvitationOutcome = { kind: 'stopped' };

function subject(attempt: Attempt): string {
  if (attempt.kind === 'create') return `the invitation to ${attempt.email}`;
  return attempt.kind === 'resend'
    ? `the new link for ${attempt.invitation.email}`
    : `the invitation for ${attempt.invitation.email}`;
}

function uncertainMessage(attempt: Attempt): string {
  return `We couldn’t confirm whether ${subject(attempt)} went through. Try again — Pertexo recognizes the repeat, so it can’t happen twice.`;
}

function commandError(error: unknown, attempt: Attempt): string {
  if (
    isApiError(error) &&
    error.problem?.code === 'workspace.invitation_delivery_unavailable'
  )
    return 'The last email for this invitation is still being delivered. Wait a minute before sending a new link.';
  if (isApiError(error) && error.status === 409)
    return attempt.kind === 'create'
      ? `${attempt.email} already has a pending invitation or is a member.`
      : 'This invitation changed meanwhile. The list now shows its latest state.';
  return describeCommandError(error, `sending ${subject(attempt)}`);
}

/**
 * Invitation commands with the session re-checked first. An unconfirmed
 * command stays locked with its exact body and key until it is retried or
 * dismissed; everything else resolves to a worded outcome.
 */
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
  const invitationsKey = workspaceInvitationKeys.list(
    input.userId,
    input.workspaceId,
  );

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

  async function verifySession(
    scope: symbol,
    attempt: Attempt,
  ): Promise<InvitationOutcome | undefined> {
    try {
      await assertSessionIdentity(input.apiClient, input.userId);
      return owner.current === scope ? undefined : STOPPED;
    } catch (error) {
      if (owner.current !== scope) return STOPPED;
      if (isSessionIdentityChangedError(error) || isUnauthenticated(error)) {
        transition({ kind: 'idle' });
        input.onAuthenticationLost();
        return STOPPED;
      }
      if (isSessionIdentityUnverifiedError(error)) {
        const message =
          'We couldn’t check your session. Try again — the same invitation command is kept.';
        transition({ kind: 'uncertain', attempt, message });
        return { kind: 'uncertain', message };
      }
      throw error;
    }
  }

  async function settleFailure(
    scope: symbol,
    attempt: Attempt,
    error: unknown,
  ): Promise<InvitationOutcome> {
    if (isUncertainOutcome(error)) {
      const message = uncertainMessage(attempt);
      transition({ kind: 'uncertain', attempt, message });
      return { kind: 'uncertain', message };
    }
    if (isUnauthenticated(error)) {
      transition({ kind: 'idle' });
      input.onAuthenticationLost();
      return STOPPED;
    }
    if (isApiError(error) && (error.status === 403 || error.status === 404)) {
      transition({ kind: 'idle' });
      input.onPermissionLost();
      return STOPPED;
    }
    if (isApiError(error) && error.status === 409)
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
    if (owner.current !== scope) return STOPPED;
    const message = commandError(error, attempt);
    transition({ kind: 'idle', message });
    return { kind: 'failed', message };
  }

  async function execute(attempt: Attempt): Promise<InvitationOutcome> {
    const scope = owner.current;
    if (scope === undefined || inFlight.current) return STOPPED;
    inFlight.current = true;
    transition({ kind: 'executing', attempt });
    try {
      const blocked = await verifySession(scope, attempt);
      if (blocked !== undefined) return blocked;
      await mutation.mutateAsync(attempt);
      if (owner.current !== scope) return STOPPED;
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
      if (owner.current !== scope) return STOPPED;
      transition({ kind: 'idle' });
      return { kind: 'done' };
    } catch (error) {
      if (owner.current !== scope) return STOPPED;
      return await settleFailure(scope, attempt, error);
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
        : Promise.resolve(STOPPED),
    change: (invitation: WorkspaceInvitation, kind: 'resend' | 'revoke') =>
      stateRef.current.kind === 'idle'
        ? execute({
            kind,
            invitation,
            expectedRevision: invitation.revision,
            idempotencyKey: crypto.randomUUID(),
          })
        : Promise.resolve(STOPPED),
    retry: () => {
      const current = stateRef.current;
      return current.kind === 'uncertain'
        ? execute(current.attempt)
        : Promise.resolve(STOPPED);
    },
    dismiss: () => {
      transition({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: invitationsKey });
    },
  };
}
