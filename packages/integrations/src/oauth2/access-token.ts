import timers from 'node:timers/promises';

import type {
  OAuth2AccessToken,
  OAuth2Grant,
  OAuth2Token,
} from './contract.js';
import { OAuth2TokenFailure } from './contract.js';
import {
  loseOAuth2Grant,
  openStoredTokens,
  refreshOAuth2Grant,
  type OAuth2TokenScope,
  type OAuth2TokenServiceDependencies,
  type RefreshOutcome,
} from './refresh.js';
import { decodeClientSettings } from './stored.js';

const RENEW_WITHIN_MILLIS = 60_000;
const REFRESH_BLOCK_SECONDS = 45;
const WAIT_LIMIT_MILLIS = 20_000;
const WAIT_STEP_MILLIS = 250;
const MINIMUM_REJECTED_AGE_SECONDS = 60;
const MAXIMUM_PASSES = 8;

export type { OAuth2TokenScope } from './refresh.js';

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

const isDue = ({ expiresAt, now }: OAuth2Token): boolean =>
  expiresAt !== null &&
  expiresAt.getTime() - now.getTime() <= RENEW_WITHIN_MILLIS;

const isExpired = ({ expiresAt, now }: OAuth2Token): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime();

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

/**
 * The one way to a usable token, for steps and connection tests alike: read,
 * renew if due, wait for whoever else is renewing, and start over whenever the
 * version read has changed. Expiry is read by database time and judged here.
 */
export function createOAuth2TokenService(
  dependencies: OAuth2TokenServiceDependencies,
): OAuth2TokenService {
  const { store } = dependencies;
  const inFlight = new Set<Promise<unknown>>();

  const useToken = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    signal: AbortSignal,
  ): Promise<OAuth2AccessToken> => {
    const tokens = await openStoredTokens(
      dependencies,
      scope,
      grant.token,
      signal,
    );
    return Object.freeze({
      accessToken: tokens.accessToken,
      tokenVersionId: grant.token.id,
      secretVersionId: grant.secretVersionId,
      requestHosts: decodeClientSettings(grant.settings).requestHosts,
    });
  };

  const startRefresh = (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
  ): Promise<RefreshOutcome> => {
    const work = refreshOAuth2Grant(dependencies, scope, grant);
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
        current?.id !== token.id ||
        current.blockedUntil === null ||
        current.blockedUntil.getTime() <= current.now.getTime()
      )
        return;
    }
  };

  /** One pass: a token to use, or undefined when the version moved and it's worth another. */
  const pass = async (
    scope: OAuth2TokenScope,
    grant: OAuth2Grant,
    deadline: number,
    signal: AbortSignal,
  ): Promise<OAuth2AccessToken | undefined> => {
    const { token } = grant;
    if (!isDue(token)) return useToken(scope, grant, signal);
    if (!token.renewable) {
      if (!isExpired(token)) return useToken(scope, grant, signal);
      if (
        await loseOAuth2Grant(
          dependencies,
          scope,
          token,
          'connection.oauth2_token_expired',
        )
      )
        throw new OAuth2TokenFailure('http.oauth2_token_expired');
      return undefined;
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
      return undefined;
    }
    const outcome = await raceSignal(startRefresh(scope, grant), signal);
    if (outcome.kind === 'renewed') return outcome.token;
    if (outcome.kind === 'changed') return undefined;
    // A token that still works is the answer; the outage only matters once it doesn't.
    if (!isExpired(token)) return useToken(scope, grant, signal);
    throw outcome.failure;
  };

  return Object.freeze({
    accessToken: async (scope, signal) => {
      const deadline = performance.now() + WAIT_LIMIT_MILLIS;
      for (let attempt = 0; attempt < MAXIMUM_PASSES; attempt += 1) {
        const grant = await store.openOAuth2Grant({
          workspaceId: scope.workspaceId,
          connectionId: scope.connectionId,
          signal,
        });
        if (grant === null)
          throw new OAuth2TokenFailure('http.oauth2_not_connected');
        const token = await pass(scope, grant, deadline, signal);
        if (token !== undefined) return token;
      }
      throw new OAuth2TokenFailure('http.oauth2_refresh_busy');
    },
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
