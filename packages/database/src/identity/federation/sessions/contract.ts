import type { SessionAuthenticationProof } from './policy.js';

export type AuthenticationSession = Readonly<{
  id: string;
  userId: string;
  proof: SessionAuthenticationProof;
}>;

export type IdentityEmailChangeEligibility =
  'allowed' | 'managed' | 'alternative_required';
