import type {
  OAuth2ClientSettings,
  OAuth2StepFailureCode,
} from '@pertexo/contracts';

import type { SealedConnectionSecret } from '../credentials/envelope-encryption.js';

export type OAuth2Token = Readonly<{
  id: string;
  sealed: SealedConnectionSecret;
  renewable: boolean;
  expiresAt: Date | null;
  blockedUntil: Date | null;
  now: Date;
}>;

export type OAuth2Grant = Readonly<{
  secretVersionId: string;
  settings: unknown;
  clientSecret: SealedConnectionSecret;
  token: OAuth2Token;
}>;

export type OAuth2IssuedRow = Readonly<{
  id: string;
  sealed: SealedConnectionSecret;
  expiresInSeconds: number | null;
  renewable: boolean;
}>;

type Scope = Readonly<{ workspaceId: string; connectionId: string }>;
type Version = Scope & Readonly<{ tokenId: string }>;

export type OAuth2GrantLossActor =
  | Readonly<{ source: 'run'; workerId: string }>
  | Readonly<{
      source: 'test';
      actorId: string;
      requestId?: string;
      traceId?: string;
    }>;

/**
 * Storage for a grant. The database package implements it, since integrations
 * may not import database. Writes that replace or remove tokens take the version
 * read and answer false when it has changed.
 */
export type OAuth2TokenStore = Readonly<{
  openOAuth2Grant(
    input: Scope & Readonly<{ signal?: AbortSignal }>,
  ): Promise<OAuth2Grant | null>;
  readOAuth2Token(
    input: Scope & Readonly<{ signal?: AbortSignal }>,
  ): Promise<OAuth2Token | null>;
  claimOAuth2Refresh(
    input: Version & Readonly<{ blockSeconds: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
  blockOAuth2Refresh(
    input: Version & Readonly<{ blockSeconds: number }>,
  ): Promise<void>;
  commitOAuth2Refresh(
    input: Version & Readonly<{ issued: OAuth2IssuedRow }>,
  ): Promise<boolean>;
  loseOAuth2Grant(
    input: Version &
      Readonly<{ errorCode: string; actor: OAuth2GrantLossActor }>,
  ): Promise<boolean>;
  rejectOAuth2Token(
    input: Version &
      Readonly<{ minimumAgeSeconds: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
}>;

/** Why a step or a connection test has no token. Each code has one meaning. */
export class OAuth2TokenFailure extends Error {
  public override readonly name = 'OAuth2TokenFailure';
  public constructor(
    public readonly code: OAuth2StepFailureCode,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`OAuth2 token unavailable: ${code}`);
  }
}

export type OAuth2AccessToken = Readonly<{
  accessToken: string;
  tokenVersionId: string;
  secretVersionId: string;
  requestHosts: OAuth2ClientSettings['requestHosts'];
}>;
