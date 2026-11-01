import timers from 'node:timers/promises';

import type { OAuth2ClientSettings } from '@pertexo/contracts';

import type {
  ConnectionEnvelopeEncryption,
  ConnectionSecretContext,
  SealedConnectionSecret,
} from '../credentials/envelope-encryption.js';
import type { SecureHttpClient } from '../http/secure.js';

import type {
  OAuth2AccessToken,
  OAuth2Grant,
  OAuth2GrantLossActor,
  OAuth2Token,
  OAuth2TokenStore,
} from './contract.js';
import { OAuth2TokenFailure } from './contract.js';
import {
  decodeClientSettings,
  decodeStoredClientSecret,
  decodeStoredTokens,
  encodeStoredTokens,
  isRenewable,
  type OAuth2StoredTokens,
} from './stored.js';
import {
  requestOAuth2Token,
  UNUSABLE_TOKEN_ANSWER,
  type OAuth2TokenAnswer,
} from './token-endpoint.js';

const COMMIT_ATTEMPTS = 3;
const COMMIT_DELAY_MILLIS = 1_000;
/** Sealing must not hold a refresh that has already been answered for long. */
const CIPHER_TIMEOUT_MILLIS = 30_000;
/** Longer than a token request, and than one seal and commit: see L1. */
export const REFRESH_BLOCK_SECONDS = 45;

export type OAuth2TokenScope = Readonly<{
  workspaceId: string;
  connectionId: string;
  loss: OAuth2GrantLossActor;
}>;

export type OAuth2TokenServiceDependencies = Readonly<{
  store: OAuth2TokenStore;
  encryption: Pick<ConnectionEnvelopeEncryption, 'open' | 'seal'>;
  httpClient: Pick<SecureHttpClient, 'execute'>;
  newId: () => string;
}>;

export type RefreshOutcome =
  | Readonly<{ kind: 'renewed'; token: OAuth2AccessToken }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'temporary'; failure: OAuth2TokenFailure }>;

const CHANGED: RefreshOutcome = Object.freeze({ kind: 'changed' });

/** Keeps new tokens through a short database or KMS outage; the caller zeroes them after. */
export async function withCommitAttempts<Result>(
  write: () => Promise<Result>,
): Promise<Result> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error: unknown) {
      if (attempt >= COMMIT_ATTEMPTS) throw error;
      await timers.setTimeout(COMMIT_DELAY_MILLIS);
    }
  }
}

function secretContext(
  scope: OAuth2TokenScope,
  secretVersionId: string,
): ConnectionSecretContext {
  return {
    workspaceId: scope.workspaceId,
    connectionId: scope.connectionId,
    secretVersionId,
  };
}

/** The row's own id is in the authenticated data, so a copied ciphertext won't open. */
export async function openStoredTokens(
  { encryption }: OAuth2TokenServiceDependencies,
  scope: OAuth2TokenScope,
  token: OAuth2Token,
  signal: AbortSignal,
): Promise<OAuth2StoredTokens> {
  const bytes = await encryption.open(
    token.sealed,
    secretContext(scope, token.id),
    signal,
  );
  try {
    return decodeStoredTokens(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function openClientSecret(
  { encryption }: OAuth2TokenServiceDependencies,
  scope: OAuth2TokenScope,
  grant: OAuth2Grant,
  signal: AbortSignal,
): Promise<string> {
  const bytes = await encryption.open(
    grant.clientSecret,
    secretContext(scope, grant.secretVersionId),
    signal,
  );
  try {
    return decodeStoredClientSecret(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** RFC 6749 §6: an answer with no refresh token keeps the one held. */
function nextTokens(
  stored: OAuth2StoredTokens,
  answer: Extract<OAuth2TokenAnswer, { kind: 'issued' }>,
): OAuth2StoredTokens {
  const refreshToken = answer.refreshToken ?? stored.refreshToken;
  return {
    accessToken: answer.accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

export async function loseOAuth2Grant(
  { store }: OAuth2TokenServiceDependencies,
  scope: OAuth2TokenScope,
  token: OAuth2Token,
  errorCode: string,
): Promise<boolean> {
  return withCommitAttempts(() =>
    store.loseOAuth2Grant({
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      tokenId: token.id,
      errorCode,
      actor: scope.loss,
    }),
  );
}

/** What a refresh sends, opened before anyone claims it. */
export type OpenedOAuth2Grant = Readonly<{
  settings: OAuth2ClientSettings;
  stored: OAuth2StoredTokens;
  clientSecret: string;
}>;

/**
 * Before the claim, so a slow KMS can't use up the block while a refresh token
 * waits to be sent: once claimed, only the token request stands before the answer.
 */
export async function openOAuth2Grant(
  dependencies: OAuth2TokenServiceDependencies,
  scope: OAuth2TokenScope,
  grant: OAuth2Grant,
  signal: AbortSignal,
): Promise<OpenedOAuth2Grant> {
  return Object.freeze({
    settings: decodeClientSettings(grant.settings),
    stored: await openStoredTokens(dependencies, scope, grant.token, signal),
    clientSecret: await openClientSecret(dependencies, scope, grant, signal),
  });
}

type Refreshing = Readonly<{
  dependencies: OAuth2TokenServiceDependencies;
  scope: OAuth2TokenScope;
  grant: OAuth2Grant;
  settings: OAuth2ClientSettings;
  stored: OAuth2StoredTokens;
}>;

async function commitIssued(
  refreshing: Refreshing,
  answer: Extract<OAuth2TokenAnswer, { kind: 'issued' }>,
): Promise<RefreshOutcome> {
  const { dependencies, scope, grant, settings, stored } = refreshing;
  const tokens = nextTokens(stored, answer);
  const id = dependencies.newId();
  const plaintext = encodeStoredTokens(tokens);
  let sealed: SealedConnectionSecret | undefined;
  try {
    const committed = await withCommitAttempts(async () => {
      // The service may have rotated: nobody may ask with the old token meanwhile.
      await blockFor(refreshing, REFRESH_BLOCK_SECONDS);
      sealed ??= await dependencies.encryption.seal(
        plaintext,
        secretContext(scope, id),
        AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
      );
      return dependencies.store.commitOAuth2Refresh({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        tokenId: grant.token.id,
        issued: {
          id,
          sealed,
          expiresInSeconds: answer.expiresInSeconds,
          renewable: isRenewable(settings, tokens),
        },
      });
    });
    if (!committed) return CHANGED;
    return Object.freeze({
      kind: 'renewed',
      token: Object.freeze({
        accessToken: tokens.accessToken,
        tokenVersionId: id,
        secretVersionId: grant.secretVersionId,
        requestHosts: settings.requestHosts,
      }),
    });
  } finally {
    plaintext.fill(0);
  }
}

/** Sets the next time anyone may ask; the claim's longer block still stands if this fails. */
async function blockFor(
  { dependencies, scope, grant }: Refreshing,
  blockSeconds: number,
): Promise<void> {
  await dependencies.store
    .blockOAuth2Refresh({
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      tokenId: grant.token.id,
      blockSeconds,
    })
    .catch(() => undefined);
}

async function actOnAnswer(
  refreshing: Refreshing,
  answer: OAuth2TokenAnswer,
): Promise<RefreshOutcome> {
  const { dependencies, scope, grant } = refreshing;
  switch (answer.kind) {
    case 'issued':
      return commitIssued(refreshing, answer);
    case 'grant_lost':
      if (
        await loseOAuth2Grant(
          dependencies,
          scope,
          grant.token,
          'connection.oauth2_grant_revoked',
        )
      )
        throw new OAuth2TokenFailure('http.oauth2_grant_revoked');
      return CHANGED;
    case 'client_refused':
      if (
        await loseOAuth2Grant(
          dependencies,
          scope,
          grant.token,
          'connection.oauth2_client_rejected',
        )
      )
        throw new OAuth2TokenFailure('http.oauth2_client_rejected');
      return CHANGED;
    case 'address_blocked':
      await blockFor(refreshing, 0);
      throw new OAuth2TokenFailure('http.oauth2_token_address_blocked');
    case 'rate_limited':
      await blockFor(refreshing, answer.retryAfterSeconds);
      return Object.freeze({
        kind: 'temporary',
        failure: new OAuth2TokenFailure(
          'http.oauth2_token_rate_limited',
          answer.retryAfterSeconds,
        ),
      });
    case 'unavailable':
      await blockFor(refreshing, answer.retryAfterSeconds);
      return Object.freeze({
        kind: 'temporary',
        failure: new OAuth2TokenFailure(
          'http.oauth2_token_endpoint_unavailable',
        ),
      });
    case 'invalid':
      await blockFor(refreshing, answer.retryAfterSeconds);
      return Object.freeze({
        kind: 'temporary',
        failure: new OAuth2TokenFailure('http.oauth2_token_response_invalid'),
      });
  }
}

/** Runs to the end whatever happens to the step that started it (L4). */
export async function refreshOAuth2Grant(
  dependencies: OAuth2TokenServiceDependencies,
  scope: OAuth2TokenScope,
  grant: OAuth2Grant,
  { settings, stored, clientSecret }: OpenedOAuth2Grant,
): Promise<RefreshOutcome> {
  const refreshing = { dependencies, scope, grant, settings, stored };
  if (settings.grantType === 'client_credentials')
    return actOnAnswer(
      refreshing,
      await requestOAuth2Token(
        dependencies.httpClient,
        settings,
        clientSecret,
        { grantType: 'client_credentials' },
      ),
    );
  if (stored.refreshToken === undefined)
    return actOnAnswer(refreshing, UNUSABLE_TOKEN_ANSWER);
  return actOnAnswer(
    refreshing,
    await requestOAuth2Token(dependencies.httpClient, settings, clientSecret, {
      grantType: 'refresh_token',
      refreshToken: stored.refreshToken,
    }),
  );
}
