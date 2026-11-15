import type { SessionAuthenticationProof } from './policy.js';

export type AuthenticationSession = Readonly<{
  id: string;
  userId: string;
  proof: SessionAuthenticationProof;
}>;

export type IdentityEmailChangeEligibility =
  'allowed' | 'managed' | 'alternative_required';

/** The Better Auth session that replaces every session of a user. */
export type ReplacementSessionInput = Readonly<{
  id: string;
  token: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}>;
export type AuthenticationReplacement = ReplacementSessionInput &
  Readonly<{ sourceSessionId: string }>;
