export type SocialSignInAttempt = Readonly<{
  id: string;
  provider: string;
  returnPath: string;
}>;

export type ProvenSocialSignIn = Readonly<{
  attemptId: string;
  provider: string;
  stateDigest: Buffer;
  browserDigest: Buffer;
  identity: Readonly<{
    accountId: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string;
  }>;
}>;

export type SocialSignInResult =
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'signed_in'; token: string; returnPath: string }>;
