import { IdentityError } from './identity.errors.js';
import { FRESH_SIGN_IN_WINDOW_MILLIS } from '@pertexo/workflow-model';

/** The fresh sign-in sensitive account-owned commands need. */
export function assertRecentSignIn(signedInAt: Date, now: Date): void {
  if (now.getTime() - signedInAt.getTime() > FRESH_SIGN_IN_WINDOW_MILLIS)
    throw new IdentityError('identity.session_not_fresh');
}
