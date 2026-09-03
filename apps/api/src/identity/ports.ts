import type {
  ExternalIdentity,
  InternalIdentity,
  OidcLoginTransaction,
  SafeClientMetadata,
  SessionCookieOptions,
  SessionLookup,
  SessionRecord,
  VerifiedOidcProfile,
} from './types.js';

export interface OidcLoginTransactionStore {
  create(transaction: OidcLoginTransaction): Promise<void>;
  /** Atomically verifies the browser binding and consumes the transaction. */
  consume(
    stateDigest: string,
    browserBindingDigest: string,
    now: Date,
  ): Promise<OidcTransactionConsumeResult | undefined>;
}

export type OidcTransactionConsumeResult = Readonly<{
  status: 'ok' | 'missing' | 'expired' | 'replayed' | 'binding_mismatch';
  transaction?: OidcLoginTransaction;
}>;

export type OidcAuthorizationRequest = Readonly<{
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  clientId: string;
  scopes: readonly string[];
}>;

export type OidcTokenResponse = Readonly<{
  issuer: string;
  subject: string;
  audience: string | readonly string[];
  nonce: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
}>;

export interface OidcProviderPort {
  authorizationUrl(request: OidcAuthorizationRequest): string;
  exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }>,
  ): Promise<OidcTokenResponse>;
}

export interface InternalIdentityMapperPort {
  mapExternalIdentity(
    identity: ExternalIdentity,
    profile: VerifiedOidcProfile,
  ): Promise<InternalIdentity | undefined>;
}

export interface SessionStorePort {
  create(record: SessionRecord): Promise<void>;
  findByDigest(tokenDigest: string): Promise<SessionRecord | undefined>;
  revokeByDigest(tokenDigest: string, revokedAt: Date): Promise<boolean>;
}

export interface SessionCookieBoundary {
  writeSessionCookie(
    token: string,
    options: SessionCookieOptions,
  ): void | Promise<void>;
}

export interface IdentityClock {
  now(): Date;
}

export type SessionIssueInput = Readonly<{
  userId: string;
  clientMetadata?: SafeClientMetadata;
}>;

export type SessionIssueResult = Readonly<{
  sessionId: string;
  expiresAt: Date;
  cookieOptions: SessionCookieOptions;
}>;

export type AuthenticatedSession = SessionLookup;
