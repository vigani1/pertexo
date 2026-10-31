import timers from 'node:timers/promises';

import type { OAuth2ClientSettings } from '@pertexo/contracts';

import type {
  ConnectionEnvelopeEncryption,
  ConnectionSecretContext,
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

const RENEW_WITHIN_MILLIS = 60_000;
const REFRESH_BLOCK_SECONDS = 45;
const WAIT_LIMIT_MILLIS = 20_000;
const WAIT_STEP_MILLIS = 250;
const MINIMUM_REJECTED_AGE_SECONDS = 60;
const COMMIT_ATTEMPTS = 3;
const COMMIT_DELAY_MILLIS = 1_000;
const MAXIMUM_PASSES = 8;
/** Opening a key must not hold a refresh that has already been answered. */
const CIPHER_TIMEOUT_MILLIS = 30_000;

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

export type OAuth2TokenService = Readonly<{
  accessToken(
    scope: OAuth2TokenScope,
    signal: AbortSignal,
  ): Promise<OAuth2AccessToken>;
  /** Asks for renewal after an API's 401; false means nothing changed. */
  rejectToken(
    scope: OAuth2TokenScope,
    tokenVersionId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Lets refreshes already at the service commit before their process closes. */
  drain(): Promise<void>;
}>;

type RefreshOutcome =
  | Readonly<{ kind: 'renewed'; token: OAuth2AccessToken }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'temporary'; failure: OAuth2TokenFailure }>;

const isDue = ({ expiresAt, now }: OAuth2Token): boolean =>
  expiresAt !== null &&
  expiresAt.getTime() - now.getTime() <= RENEW_WITHIN_MILLIS;

const isExpired = ({ expiresAt, now }: OAuth2Token): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime();

/** Keeps new tokens through a short database outage; the caller zeroes them after. */
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

function raceSignal<Result>(
  work: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      })
      .catch(() => undefined);
  });
}

export function createOAuth2TokenService(
  dependencies: OAuth2TokenServiceDependencies,
): OAuth2TokenService {
  const { store, encryption, httpClient, newId } = dependencies;
  const inFlight = new Set<Promise<unknown>>();

  const context = (
    scope: OAuth2TokenScope,
    secretVersionId: string,
  ): ConnectionSecretContext => ({
    workspaceId: scope.workspaceId,
    connectionId: scope.connectionId,
    secretVersionId,
  });

  const openTokens = async (
    scope: OAuth2TokenScope,
    token: OAuth2Token,
    signal: AbortSignal,
  ): Promise<OAuth2StoredTokens> => {
    const bytes = await encryption.open(
      token.sealed,
      context(scope, token.id),
      signal,
    );
    try {
      return decodeStoredTokens(bytes);
    } finally {
      bytes.fill(0);
    }
  };

  const useToken = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    signal: AbortSignal,
  ): Promise<OAuth2AccessToken> => {
    const tokens = await openTokens(scope, grant.token, signal);
    return Object.freeze({
      accessToken: tokens.accessToken,
      tokenVersionId: grant.token.id,
      secretVersionId: grant.secretVersionId,
      requestHosts: decodeClientSettings(grant.settings).requestHosts,
    });
  };

  const openClientSecret = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    signal: AbortSignal,
  ): Promise<string> => {
    const bytes = await encryption.open(
      grant.clientSecret,
      context(scope, grant.secretVersionId),
      signal,
    );
    try {
      return decodeStoredClientSecret(bytes);
    } finally {
      bytes.fill(0);
    }
  };

  const commitIssued = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    settings: OAuth2ClientSettings,
    stored: OAuth2StoredTokens,
    answer: Extract<OAuth2TokenAnswer, { kind: 'issued' }>,
  ): Promise<RefreshOutcome> => {
    // RFC 6749 §6: an answer with no refresh token keeps the one held.
    const tokens: OAuth2StoredTokens = {
      accessToken: answer.accessToken,
      ...(answer.refreshToken === undefined
        ? stored.refreshToken === undefined
          ? {}
          : { refreshToken: stored.refreshToken }
        : { refreshToken: answer.refreshToken }),
    };
    const id = newId();
    const plaintext = encodeStoredTokens(tokens);
    try {
      const sealed = await encryption.seal(
        plaintext,
        context(scope, id),
        AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS),
      );
      const committed = await withCommitAttempts(() =>
        store.commitOAuth2Refresh({
          workspaceId: scope.workspaceId,
          connectionId: scope.connectionId,
          tokenId: grant.token.id,
          issued: {
            id,
            sealed,
            expiresInSeconds: answer.expiresInSeconds,
            renewable: isRenewable(settings, tokens),
          },
        }),
      );
      if (!committed) return Object.freeze({ kind: 'changed' });
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
  };

  const lose = async (
    scope: OAuth2TokenScope,
    token: OAuth2Token,
    errorCode: string,
  ): Promise<boolean> =>
    withCommitAttempts(() =>
      store.loseOAuth2Grant({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        tokenId: token.id,
        errorCode,
        actor: scope.loss,
      }),
    );

  /** Sets the next time anyone may ask; the claim's longer block still stands if this fails. */
  const blockFor = async (
    scope: OAuth2TokenScope,
    token: OAuth2Token,
    blockSeconds: number,
  ): Promise<void> => {
    await store
      .blockOAuth2Refresh({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        tokenId: token.id,
        blockSeconds,
      })
      .catch(() => undefined);
  };

  const actOnAnswer = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    settings: OAuth2ClientSettings,
    stored: OAuth2StoredTokens,
    answer: OAuth2TokenAnswer,
  ): Promise<RefreshOutcome> => {
    const { token } = grant;
    switch (answer.kind) {
      case 'issued':
        return commitIssued(scope, grant, settings, stored, answer);
      case 'grant_lost':
        if (await lose(scope, token, 'connection.oauth2_grant_revoked'))
          throw new OAuth2TokenFailure('http.oauth2_grant_revoked');
        return Object.freeze({ kind: 'changed' });
      case 'client_refused':
        if (await lose(scope, token, 'connection.oauth2_client_rejected'))
          throw new OAuth2TokenFailure('http.oauth2_client_rejected');
        return Object.freeze({ kind: 'changed' });
      case 'address_blocked':
        await blockFor(scope, token, 0);
        throw new OAuth2TokenFailure('http.oauth2_token_address_blocked');
      case 'rate_limited':
        await blockFor(scope, token, answer.retryAfterSeconds);
        return Object.freeze({
          kind: 'temporary',
          failure: new OAuth2TokenFailure(
            'http.oauth2_token_rate_limited',
            answer.retryAfterSeconds,
          ),
        });
      case 'unavailable':
        await blockFor(scope, token, answer.retryAfterSeconds);
        return Object.freeze({
          kind: 'temporary',
          failure: new OAuth2TokenFailure(
            'http.oauth2_token_endpoint_unavailable',
          ),
        });
      case 'invalid':
        await blockFor(scope, token, answer.retryAfterSeconds);
        return Object.freeze({
          kind: 'temporary',
          failure: new OAuth2TokenFailure('http.oauth2_token_response_invalid'),
        });
    }
  };

  /** Runs to the end whatever happens to the step that started it (L4). */
  const refresh = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
  ): Promise<RefreshOutcome> => {
    const cipher = AbortSignal.timeout(CIPHER_TIMEOUT_MILLIS);
    const settings = decodeClientSettings(grant.settings);
    const stored = await openTokens(scope, grant.token, cipher);
    const clientSecret = await openClientSecret(scope, grant, cipher);
    if (
      settings.grantType !== 'client_credentials' &&
      stored.refreshToken === undefined
    )
      return actOnAnswer(scope, grant, settings, stored, UNUSABLE_TOKEN_ANSWER);
    const answer = await requestOAuth2Token(
      httpClient,
      settings,
      clientSecret,
      settings.grantType === 'client_credentials'
        ? { grantType: 'client_credentials' }
        : {
            grantType: 'refresh_token',
            refreshToken: stored.refreshToken ?? '',
          },
    );
    return actOnAnswer(scope, grant, settings, stored, answer);
  };

  const startRefresh = (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
  ): Promise<RefreshOutcome> => {
    const work = refresh(scope, grant);
    inFlight.add(work);
    work
      .finally(() => {
        inFlight.delete(work);
      })
      .catch(() => undefined);
    return work;
  };

  /** Until the version changes or the block lifts; then the caller starts over. */
  const waitForRefresh = async (
    scope: OAuth2TokenScope,
    token: OAuth2Token,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> => {
    for (;;) {
      if (performance.now() >= deadline)
        throw new OAuth2TokenFailure('http.oauth2_refresh_busy');
      await timers.setTimeout(WAIT_STEP_MILLIS, undefined, { signal });
      const current = await store.readOAuth2Token({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        signal,
      });
      if (
        current === null ||
        current.id !== token.id ||
        current.blockedUntil === null ||
        current.blockedUntil.getTime() <= current.now.getTime()
      )
        return;
    }
  };

  const accessToken: OAuth2TokenService['accessToken'] = async (
    scope,
    signal,
  ) => {
    const reopen = (): Promise<OAuth2Grant | null> =>
      store.openOAuth2Grant({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        signal,
      });
    let grant = await reopen();
    const deadline = performance.now() + WAIT_LIMIT_MILLIS;
    for (let pass = 0; pass < MAXIMUM_PASSES; pass += 1) {
      if (grant === null)
        throw new OAuth2TokenFailure('http.oauth2_not_connected');
      const { token } = grant;
      if (!isDue(token)) return useToken(scope, grant, signal);
      if (!token.renewable) {
        if (!isExpired(token)) return useToken(scope, grant, signal);
        if (await lose(scope, token, 'connection.oauth2_token_expired'))
          throw new OAuth2TokenFailure('http.oauth2_token_expired');
        grant = await reopen();
        continue;
      }
      const claimed = await store.claimOAuth2Refresh({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        tokenId: token.id,
        blockSeconds: REFRESH_BLOCK_SECONDS,
        signal,
      });
      if (!claimed) {
        if (!isExpired(token)) return useToken(scope, grant, signal);
        await waitForRefresh(scope, token, deadline, signal);
        grant = await reopen();
        continue;
      }
      const outcome = await raceSignal(startRefresh(scope, grant), signal);
      if (outcome.kind === 'renewed') return outcome.token;
      if (outcome.kind === 'temporary') {
        // A token that still works is the answer; the outage only matters once it doesn't.
        if (!isExpired(token)) return useToken(scope, grant, signal);
        throw outcome.failure;
      }
      grant = await reopen();
    }
    throw new OAuth2TokenFailure('http.oauth2_refresh_busy');
  };

  return Object.freeze({
    accessToken,
    rejectToken: (scope, tokenVersionId, signal) =>
      store.rejectOAuth2Token({
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        tokenId: tokenVersionId,
        minimumAgeSeconds: MINIMUM_REJECTED_AGE_SECONDS,
        signal,
      }),
    drain: async () => {
      await Promise.allSettled([...inFlight]);
    },
  });
}
