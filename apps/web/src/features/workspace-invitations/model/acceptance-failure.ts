import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';

export type AcceptanceFailure = Readonly<{
  kind:
    'authentication' | 'cleanup' | 'definite' | 'uncertain' | 'verification';
  message: string;
}>;

const UNCERTAIN_ACCEPTANCE: AcceptanceFailure = {
  kind: 'uncertain',
  message:
    'We couldn’t confirm whether you joined. Check the status; checking never accepts twice.',
};

export const NOT_JOINED_YET: AcceptanceFailure = {
  kind: 'uncertain',
  message:
    'You haven’t joined yet. Accepting again repeats the same request, so nothing happens twice.',
};

export const DIFFERENT_INVITATION: AcceptanceFailure = {
  kind: 'definite',
  message:
    'A different invitation is now selected. Review it before accepting.',
};

export const SIGN_IN_AGAIN: AcceptanceFailure = {
  kind: 'authentication',
  message:
    'Sign in again with the invited account, then check whether you joined.',
};

export const CLEANUP_UNFINISHED: AcceptanceFailure = {
  kind: 'cleanup',
  message:
    'You joined, but we couldn’t finish tidying up the invitation. Open the workspace from here.',
};

export const NOT_SET_ASIDE: AcceptanceFailure = {
  kind: 'definite',
  message:
    'We couldn’t set this invitation aside. Try again, or go to your workspaces.',
};

/**
 * `uncertain` marks a command whose result may already be applied: it is
 * retried with the same intent and key, never re-issued.
 */
export function acceptanceFailure(
  error: unknown,
  uncertain = false,
): AcceptanceFailure {
  if (isUncertainOutcome(error))
    return uncertain
      ? UNCERTAIN_ACCEPTANCE
      : {
          kind: 'definite',
          message:
            'We couldn’t reach Pertexo. Check your connection and try again.',
        };
  if (isApiError(error) && error.status === 401)
    return {
      kind: 'authentication',
      message:
        'Your session ended. Check whether you joined, or sign in again with the invited account.',
    };
  if (
    isApiError(error) &&
    error.problem?.code === 'workspace.invitation_proof_expired'
  )
    return {
      kind: 'verification',
      message:
        'Confirming your invited account took too long. Verify it again to continue.',
    };
  if (isApiError(error) && error.status === 409)
    return {
      kind: 'definite',
      message: 'This invitation changed or can’t be used any more.',
    };
  return uncertain
    ? {
        kind: 'uncertain',
        message:
          'We couldn’t finish accepting. Check the status before trying again.',
      }
    : {
        kind: 'definite',
        message: 'We couldn’t open this invitation. Try again.',
      };
}
