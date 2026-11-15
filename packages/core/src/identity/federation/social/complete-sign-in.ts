import type { Pool } from 'pg';
import { isUniqueConstraintFailure } from '@pertexo/database/primitives';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { SignInProofRejectedError } from '../accounts/sign-in-proof.errors.js';
import type { SignUpMode } from '../../sign-up.js';
import { completeSocialSignIn } from './complete.repository.js';
import type {
  ProvenSocialSignIn,
  SocialSignInResult,
} from './social-sign-in.types.js';

/**
 * A refused proof rolls back everything the attempt wrote, and the caller only
 * learns that it failed; so does a sign-up that lost a uniqueness race.
 */
export function completeSocialSignInCommand(
  pool: Pool,
  input: ProvenSocialSignIn,
  options: Readonly<{ sessionTtlSeconds: number; signUpMode: SignUpMode }>,
): Promise<SocialSignInResult> {
  return withPlatformTransaction(pool, async (client) => {
    const result = await completeSocialSignIn(client, input, options);
    if (result.kind === 'failed') throw new SignInProofRejectedError();
    return result;
  }).catch((error: unknown) => {
    if (error instanceof SignInProofRejectedError)
      return { kind: 'failed' } as const;
    if (isUniqueConstraintFailure(error)) return { kind: 'failed' } as const;
    throw error;
  });
}
