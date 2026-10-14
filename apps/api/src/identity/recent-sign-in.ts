import { IdentityError } from './errors.js';

/** The five-minute proof lifetime shared by sensitive account-owned commands. */
export function assertRecentSignIn(signedInAt: Date, now: Date): void {
  if (now.getTime() - signedInAt.getTime() > 5 * 60_000)
    throw new IdentityError('identity.session_not_fresh');
}
