import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  const instances: {
    query: ReturnType<typeof vi.fn>;
    connectMock: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }[] = [];
  class FakePool {
    public readonly query = vi.fn().mockResolvedValue({ rows: [] });
    public readonly connectMock = vi.fn();
    public connect = this.connectMock;
    public readonly end = vi.fn().mockResolvedValue(undefined);
    public readonly on = vi.fn().mockReturnThis();
    public constructor() {
      instances.push(this);
    }
  }
  return { FakePool, instances };
});

vi.mock('pg', () => ({ Pool: pg.FakePool }));

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceIdentityStore } from '../src/tenant-access/identity-workspace-identity-store.js';
import { createIdentityWorkspaceSessionStore } from '../src/tenant-access/identity-workspace-session-store.js';
import { mapAuthIdentity } from '../src/tenant-access/identity-workspace-rows.js';
import {
  parseIdentityMetadata,
  readIdentityDatabaseErrorCode,
} from '../src/tenant-access/identity-workspace-support.js';
import { createOidcLoginTransactionStore } from '../src/tenant-access/oidc-login-transactions.js';

const now = Date.parse('2026-09-13T09:00:00.000Z');
const config = parseDatabaseConfig({
  connectionString: 'postgresql://unused.invalid/pertexo',
});
const stateDigest = 'a'.repeat(64);
const browserBindingDigest = 'b'.repeat(64);

function oidcRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    state_digest: stateDigest,
    browser_binding_digest: browserBindingDigest,
    code_verifier_ciphertext: 'sealed-verifier',
    code_verifier_nonce: 'verifier-nonce',
    code_verifier_tag: 'verifier-tag',
    code_verifier_key_version: 'v1',
    nonce_ciphertext: 'sealed-nonce',
    nonce_nonce: 'nonce-nonce',
    nonce_tag: 'nonce-tag',
    nonce_key_version: 'v1',
    expires_at: new Date(now + 60_000),
    consumed_at: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  pg.instances.length = 0;
});

describe('identity input admission', () => {
  it('reads only bounded nonthrowing PostgreSQL error codes', () => {
    expect(readIdentityDatabaseErrorCode({ code: '23505' })).toBe('23505');
    expect(
      readIdentityDatabaseErrorCode({ code: 'not-a-sqlstate' }),
    ).toBeUndefined();
    expect(
      readIdentityDatabaseErrorCode(
        Object.defineProperty({}, 'code', {
          get: () => {
            throw new Error('hostile getter');
          },
        }),
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      'email',
      { email: `${'a'.repeat(309)}@example.test`, displayName: 'Name' },
    ],
    [
      'display name',
      { email: 'user@example.test', displayName: 'n'.repeat(257) },
    ],
  ])(
    'rejects an overlength direct user %s before SQL',
    async (_field, input) => {
      const query = vi.fn();
      const store = createIdentityWorkspaceIdentityStore({
        query,
      } as unknown as Pool);

      await expect(store.createUser(input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['invalid', new Date(Number.NaN)],
    ['equal', new Date(now)],
    ['past', new Date(now - 1)],
  ] as const)(
    'rejects %s session expiry before SQL',
    async (_label, expiresAt) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const query = vi.fn();
      const store = createIdentityWorkspaceSessionStore({
        query,
      } as unknown as Pool);

      await expect(
        store.createSession({
          id: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          tokenDigest: 'a'.repeat(64),
          expiresAt,
        }),
      ).rejects.toThrow('Session expiry must be in the future');
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['invalid', new Date(Number.NaN)],
    ['equal', new Date(now)],
    ['past', new Date(now - 1)],
  ] as const)(
    'rejects %s OIDC expiry before encryption or SQL',
    async (_label, expiresAt) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const encryption = {
        seal: vi.fn(),
        open: vi.fn(),
      };
      const store = createOidcLoginTransactionStore(config, encryption);

      await expect(
        store.create({
          stateDigest: 'a'.repeat(64),
          browserBindingDigest: 'b'.repeat(64),
          codeVerifier: 'verifier',
          nonce: 'nonce',
          expiresAt,
        }),
      ).rejects.toThrow('OIDC transaction expiry must be in the future');
      expect(encryption.seal).not.toHaveBeenCalled();
      expect(pg.instances[0]?.query).not.toHaveBeenCalled();
      await store.close();
    },
  );

  it('accepts future OIDC expiry and reaches encryption before SQL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const encryption = {
      seal: vi.fn().mockResolvedValue({
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'v1',
      }),
      open: vi.fn(),
    };
    const store = createOidcLoginTransactionStore(config, encryption);

    await expect(
      store.create({
        stateDigest: 'a'.repeat(64),
        browserBindingDigest: 'b'.repeat(64),
        codeVerifier: 'verifier',
        nonce: 'nonce',
        expiresAt: new Date(now + 1),
      }),
    ).resolves.toBeUndefined();
    expect(encryption.seal).toHaveBeenCalledTimes(2);
    expect(pg.instances[0]?.query).toHaveBeenCalledOnce();
    await store.close();
  });

  it.each([1, 2])(
    'commits consumption before OIDC secret open failure %s and rejects replay',
    async (failedOpen) => {
      let consumed = false;
      const events: string[] = [];
      const query = vi.fn((statement: string) => {
        if (statement === 'commit') events.push('commit');
        if (statement.includes('set consumed_at')) consumed = true;
        if (statement.includes('from app.oidc_login_transactions')) {
          return Promise.resolve({
            rows: [oidcRow({ consumed_at: consumed ? new Date(now) : null })],
          });
        }
        if (statement.includes("current_setting('app.workspace_id'")) {
          return Promise.resolve({
            rows: [{ workspace_id: null, actor_id: null }],
          });
        }
        return Promise.resolve({ rows: [] });
      });
      let openCount = 0;
      const encryption = {
        seal: vi.fn(),
        open: vi.fn(() => {
          openCount += 1;
          events.push(`open-${String(openCount)}`);
          if (openCount === failedOpen) throw new Error('corrupt secret');
          return openCount === 1 ? 'verifier' : 'nonce';
        }),
      };
      const store = createOidcLoginTransactionStore(config, encryption);
      pg.instances[0]?.connectMock.mockResolvedValue({
        query,
        release: vi.fn(),
      });

      await expect(
        store.consume(stateDigest, browserBindingDigest, new Date(now)),
      ).rejects.toMatchObject({
        name: 'OidcTransactionSealingError',
      });
      expect(events.indexOf('commit')).toBeLessThan(events.indexOf('open-1'));
      await expect(
        store.consume(stateDigest, browserBindingDigest, new Date(now)),
      ).resolves.toEqual({ status: 'replayed' });
      await store.close();
    },
  );

  it('fails closed on malformed stored seal fields without coercing them', async () => {
    let consumed = false;
    const query = vi.fn((statement: string) => {
      if (statement.includes('set consumed_at')) consumed = true;
      if (statement.includes('from app.oidc_login_transactions')) {
        return Promise.resolve({
          rows: [
            oidcRow({
              code_verifier_ciphertext: null,
              consumed_at: consumed ? new Date(now) : null,
            }),
          ],
        });
      }
      if (statement.includes("current_setting('app.workspace_id'")) {
        return Promise.resolve({
          rows: [{ workspace_id: null, actor_id: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const encryption = { seal: vi.fn(), open: vi.fn() };
    const store = createOidcLoginTransactionStore(config, encryption);
    pg.instances[0]?.connectMock.mockResolvedValue({
      query,
      release: vi.fn(),
    });

    await expect(
      store.consume(stateDigest, browserBindingDigest, new Date(now)),
    ).rejects.toMatchObject({ name: 'OidcTransactionSealingError' });
    expect(encryption.open).not.toHaveBeenCalled();
    await expect(
      store.consume(stateDigest, browserBindingDigest, new Date(now)),
    ).resolves.toEqual({ status: 'replayed' });
    await store.close();
  });

  it('accepts nested ordinary arrays and the exact 8 KiB metadata boundary', () => {
    const exact = { value: 'x'.repeat(8_192 - 12) };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(8_192);
    expect(parseIdentityMetadata(exact)).toEqual(exact);
    expect(parseIdentityMetadata({ nested: [{ ok: true }, null, 3] })).toEqual({
      nested: [{ ok: true }, null, 3],
    });
  });

  it.each([
    ['over byte limit', { value: 'x'.repeat(8_192 - 11) }],
    [
      'forbidden nested key',
      { nested: [{ authorizationToken: 'must-not-be-admitted' }] },
    ],
    [
      'wide object',
      Object.fromEntries(
        Array.from({ length: 1_025 }, (_, index) => [
          `k${String(index)}`,
          index,
        ]),
      ),
    ],
  ])('rejects %s metadata with a controlled error', (_label, metadata) => {
    expect(() => parseIdentityMetadata(metadata)).toThrow();
  });

  it('rejects cyclic and deeply nested metadata without recursive overflow', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth < 4_000; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }

    expect(() => parseIdentityMetadata(cyclic)).toThrow(
      'must not repeat object references',
    );
    expect(() => parseIdentityMetadata(root)).toThrow('depth limit exceeded');
  });

  it('independently rejects unsafe persisted identity metadata', () => {
    expect(() =>
      mapAuthIdentity({
        id: '11111111-1111-4111-8111-111111111111',
        user_id: '22222222-2222-4222-8222-222222222222',
        issuer: 'https://identity.example.test',
        provider_subject: 'subject',
        profile_metadata: { nested: { clientSecret: 'hidden' } },
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).toThrow('Unsafe audit metadata key');
  });
});
