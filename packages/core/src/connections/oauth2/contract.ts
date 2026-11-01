import type {
  ConnectionRecord,
  SealedConnectionSecretRecord,
} from '../contract.js';

/** A token row as read, with the database's clock: expiry is judged in TypeScript. */
export type OAuth2TokenRecord = Readonly<{
  id: string;
  sealed: SealedConnectionSecretRecord;
  renewable: boolean;
  expiresAt: Date | null;
  blockedUntil: Date | null;
  now: Date;
}>;

export type OAuth2GrantRecord = Readonly<{
  secretVersionId: string;
  settings: unknown;
  clientSecret: SealedConnectionSecretRecord;
  token: OAuth2TokenRecord;
}>;

export type OAuth2GrantLossActor =
  | Readonly<{ source: 'run'; workerId: string }>
  | Readonly<{
      source: 'test';
      actorId: string;
      requestId?: string;
      traceId?: string;
    }>;

type TokenScope = Readonly<{ workspaceId: string; connectionId: string }>;
type TokenVersion = TokenScope & Readonly<{ tokenId: string }>;

export type IssuedOAuth2Tokens = Readonly<{
  id: string;
  sealed: SealedConnectionSecretRecord;
  expiresInSeconds: number | null;
  renewable: boolean;
}>;

export type OAuth2ClientRecord = Readonly<{
  connection: ConnectionRecord;
  settings: unknown;
  clientSecret: SealedConnectionSecretRecord;
}>;

/** What consuming a state found: a refusal may still name a cookie to clear. */
export type ConsumedOAuth2Authorization =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'refused'; connectionId: string }>
  | Readonly<{
      kind: 'consumed';
      connectionId: string;
      startedBy: string;
      secretVersionId: string;
      settings: unknown;
      clientSecret: SealedConnectionSecretRecord;
    }>;

export type OpenOAuth2GrantInput = TokenScope &
  Readonly<{ signal?: AbortSignal }>;

export type ReadOAuth2TokenInput = OpenOAuth2GrantInput;

export type ClaimOAuth2RefreshInput = TokenVersion &
  Readonly<{ blockSeconds: number; signal?: AbortSignal }>;

export type BlockOAuth2RefreshInput = TokenVersion &
  Readonly<{ blockSeconds: number }>;

export type CommitOAuth2RefreshInput = TokenVersion &
  Readonly<{ issued: IssuedOAuth2Tokens }>;

export type LoseOAuth2GrantInput = TokenVersion &
  Readonly<{ errorCode: string; actor: OAuth2GrantLossActor }>;

export type RejectOAuth2TokenInput = TokenVersion &
  Readonly<{ minimumAgeSeconds: number; signal?: AbortSignal }>;

export type ReadOAuth2ClientInput = TokenScope & Readonly<{ actorId: string }>;

export type StartOAuth2AuthorizationInput = TokenScope &
  Readonly<{
    actorId: string;
    secretVersionId: string;
    stateDigest: Buffer;
    bindingDigest: Buffer;
    lifetimeSeconds: number;
  }>;

export type ConsumeOAuth2AuthorizationInput = Readonly<{
  workspaceId: string;
  stateDigest: Buffer;
  bindingDigests: readonly Buffer[];
}>;

export type ReadOAuth2EarlierTokensInput = TokenScope &
  Readonly<{ secretVersionId: string }>;

export type AuthorizeOAuth2ConnectionInput = TokenScope &
  Readonly<{
    actorId: string;
    secretVersionId: string;
    issued: IssuedOAuth2Tokens;
    requestId?: string;
    traceId?: string;
  }>;
