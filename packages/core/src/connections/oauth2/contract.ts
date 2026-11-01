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

/** Every write that replaces or removes tokens is conditional on the version read. */
export type OAuth2TokenStore = Readonly<{
  openOAuth2Grant(
    input: TokenScope & Readonly<{ signal?: AbortSignal }>,
  ): Promise<OAuth2GrantRecord | null>;
  readOAuth2Token(
    input: TokenScope & Readonly<{ signal?: AbortSignal }>,
  ): Promise<OAuth2TokenRecord | null>;
  claimOAuth2Refresh(
    input: TokenVersion &
      Readonly<{ blockSeconds: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
  blockOAuth2Refresh(
    input: TokenVersion & Readonly<{ blockSeconds: number }>,
  ): Promise<void>;
  commitOAuth2Refresh(
    input: TokenVersion & Readonly<{ issued: IssuedOAuth2Tokens }>,
  ): Promise<boolean>;
  loseOAuth2Grant(
    input: TokenVersion &
      Readonly<{ errorCode: string; actor: OAuth2GrantLossActor }>,
  ): Promise<boolean>;
  rejectOAuth2Token(
    input: TokenVersion &
      Readonly<{ minimumAgeSeconds: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
}>;

export type OAuth2ConsentStore = Readonly<{
  readOAuth2Client(
    input: TokenScope & Readonly<{ actorId: string }>,
  ): Promise<OAuth2ClientRecord>;
  startOAuth2Authorization(
    input: TokenScope &
      Readonly<{
        actorId: string;
        secretVersionId: string;
        stateDigest: Buffer;
        bindingDigest: Buffer;
        lifetimeSeconds: number;
      }>,
  ): Promise<Readonly<{ expiresAt: Date }>>;
  consumeOAuth2Authorization(
    input: Readonly<{
      workspaceId: string;
      stateDigest: Buffer;
      bindingDigests: readonly Buffer[];
    }>,
  ): Promise<ConsumedOAuth2Authorization>;
  /** The sealed tokens a reconnect would replace, if they share its settings. */
  readOAuth2EarlierTokens(
    input: TokenScope & Readonly<{ secretVersionId: string }>,
  ): Promise<Readonly<{
    id: string;
    sealed: SealedConnectionSecretRecord;
  }> | null>;
  authorizeOAuth2Connection(
    input: TokenScope &
      Readonly<{
        actorId: string;
        secretVersionId: string;
        issued: IssuedOAuth2Tokens;
        requestId?: string;
        traceId?: string;
      }>,
  ): Promise<ConnectionRecord | null>;
}>;
