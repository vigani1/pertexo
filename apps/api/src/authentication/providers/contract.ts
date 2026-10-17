import type { z } from 'zod';
import type { authenticationProviderSchema } from '@pertexo/contracts';

export type SocialProviderName = z.infer<typeof authenticationProviderSchema>;
export type VerifiedSocialIdentity = Readonly<{
  accountId: string;
  email: string | null;
  emailVerified: boolean;
}>;

export type SocialProviderGateway = Readonly<{
  available: readonly SocialProviderName[];
  authorize(
    input: Readonly<{
      provider: SocialProviderName;
      state: string;
      codeVerifier: string;
      nonce: string;
      redirectUri: string;
    }>,
  ): Promise<string>;
  verify(
    input: Readonly<{
      provider: SocialProviderName;
      code: string;
      codeVerifier: string;
      nonce: string;
      redirectUri: string;
      issuer: string | null;
    }>,
  ): Promise<VerifiedSocialIdentity | undefined>;
}>;
