import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SealedConnectionSecret } from '../../src/credentials/envelope-encryption.js';
import { createOAuth2TokenService } from '../../src/oauth2/access-token.js';
import {
  encodeStoredClientSecret,
  encodeStoredTokens,
} from '../../src/oauth2/stored.js';
import type {
  OAuth2IssuedRow,
  OAuth2Token,
} from '../../src/oauth2/contract.js';

const SCOPE = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  connectionId: '00000000-0000-4000-8000-000000000002',
  loss: { source: 'run', workerId: 'worker' },
} as const;
const SETTINGS = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'client',
  scope: 'read',
  clientAuthentication: 'body',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
} as const;
const HELD_VERSION = '00000000-0000-4000-8000-000000000003';
const NEW_VERSION = '00000000-0000-4000-8000-000000000004';
const CLIENT_VERSION = '00000000-0000-4000-8000-000000000005';
/** The token request's own limit: a block must outlast it (L1). */
const TOKEN_REQUEST_MILLIS = 15_000;

/**
 * A key service that can be slow or fail: it is the outside service here. The
 * store is the port the database implements, since this package may not import
 * the database; it keeps the rows a real one would, with no rules of its own.
 */
function connection(
  kms: Readonly<{
    openDelayMillis?: number;
    sealFailures?: number;
  }> = {},
) {
  const sealedAs = new Map<string, Uint8Array>();
  const seal = (bytes: Uint8Array): SealedConnectionSecret => {
    const key = String(sealedAs.size);
    sealedAs.set(key, Uint8Array.from(bytes));
    return { ciphertext: key } as unknown as SealedConnectionSecret;
  };
  const tokens = seal(
    encodeStoredTokens({ accessToken: 'old', refreshToken: 'held-refresh' }),
  );
  const clientSecret = seal(encodeStoredClientSecret('client-secret'));
  let sealFailures = kms.sealFailures ?? 0;
  let blockedUntil: number | null = null;
  const committed: OAuth2IssuedRow[] = [];
  const blockLeftAtRequest: number[] = [];
  const token = (): OAuth2Token => ({
    id: HELD_VERSION,
    sealed: tokens,
    renewable: true,
    expiresAt: new Date(Date.now() - 60_000),
    blockedUntil: blockedUntil === null ? null : new Date(blockedUntil),
    now: new Date(),
  });
  const block = (input: { blockSeconds: number }) => {
    blockedUntil = Date.now() + input.blockSeconds * 1_000;
  };
  const service = createOAuth2TokenService({
    newId: () => NEW_VERSION,
    encryption: {
      open: async (sealed) => {
        const { openDelayMillis = 0 } = kms;
        if (openDelayMillis > 0)
          await new Promise((resolve) => {
            setTimeout(resolve, openDelayMillis);
          });
        const key = (sealed as unknown as { ciphertext: string }).ciphertext;
        return Uint8Array.from(sealedAs.get(key) ?? []);
      },
      seal: (plaintext) => {
        if (sealFailures > 0) {
          sealFailures -= 1;
          return Promise.reject(new Error('key service blipped'));
        }
        return Promise.resolve(seal(plaintext));
      },
    },
    httpClient: {
      execute: () => {
        blockLeftAtRequest.push((blockedUntil ?? 0) - Date.now());
        return Promise.resolve({
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({
              access_token: 'new',
              refresh_token: 'rotated-refresh',
              expires_in: 3_600,
            }),
          ),
          bodyEncoding: 'utf8',
          finalUrl: SETTINGS.tokenUrl,
          redirectCount: 0,
        });
      },
    },
    store: {
      openOAuth2Grant: () =>
        Promise.resolve(
          committed.length > 0
            ? null
            : {
                secretVersionId: CLIENT_VERSION,
                settings: SETTINGS,
                clientSecret,
                token: token(),
              },
        ),
      readOAuth2Token: () => Promise.resolve(token()),
      claimOAuth2Refresh: (input) => {
        block(input);
        return Promise.resolve(true);
      },
      blockOAuth2Refresh: (input) => {
        block(input);
        return Promise.resolve();
      },
      commitOAuth2Refresh: ({ issued }) => {
        committed.push(issued);
        return Promise.resolve(true);
      },
      loseOAuth2Grant: () => Promise.resolve(true),
      rejectOAuth2Token: () => Promise.resolve(true),
    },
  });
  return { service, committed, blockLeftAtRequest };
}

describe('a refresh meeting a key service fault', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // S2: the service has already rotated, so a blip here would lose the new tokens.
  it.fails('S2 a seal that fails once still keeps the new tokens', async () => {
    const { service, committed } = connection({ sealFailures: 1 });
    await expect(
      service.accessToken(SCOPE, new AbortController().signal),
    ).resolves.toMatchObject({ accessToken: 'new' });
    expect(committed.map(({ id }) => id)).toEqual([NEW_VERSION]);
  });

  it('a healthy key service commits the new tokens once', async () => {
    const { service, committed } = connection();
    await expect(
      service.accessToken(SCOPE, new AbortController().signal),
    ).resolves.toMatchObject({ accessToken: 'new' });
    expect(committed.map(({ id }) => id)).toEqual([NEW_VERSION]);
  });

  // S3: a slow key service must not let the block lapse during the token request,
  // or a second worker sends the same refresh token and reuse detection ends the family.
  it.fails(
    'S3 the block outlasts the token request after a slow key service',
    async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
      const { service, blockLeftAtRequest } = connection({
        openDelayMillis: 16_000,
      });
      const token = service.accessToken(SCOPE, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60_000);
      await token;
      expect(blockLeftAtRequest).toHaveLength(1);
      expect(blockLeftAtRequest[0]).toBeGreaterThanOrEqual(
        TOKEN_REQUEST_MILLIS,
      );
    },
  );
});
