import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  type AuthenticationMail,
  type BetterAuthRuntime,
} from '../../src/authentication/index.js';
import type { BetterAuthRuntimeConfig } from '../../src/authentication/better-auth/runtime.js';
import type * as IdentityInfrastructure from '../../src/authentication/index.js';
import type { ApiIdentityConfig } from '../../src/platform/config/identity.js';
import { composeBetterAuthRuntime } from '../../src/platform/identity/better-auth-composition.js';

const created = vi.hoisted(() => [] as BetterAuthRuntimeConfig[]);

vi.mock('../../src/authentication/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityInfrastructure>()),
  createBetterAuthRuntime: (config: BetterAuthRuntimeConfig) => {
    created.push(config);
    return {
      auth: { handler: () => Promise.resolve(new Response(null)) },
      sessions: {},
      close: () => Promise.resolve(),
    } as unknown as BetterAuthRuntime;
  },
}));

const databaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
};
const session = {
  ttlMillis: 90_000,
  secureCookie: true,
  sameSite: 'lax' as const,
};
function betterAuth(
  mailMode: 'local' | 'durable',
): ApiIdentityConfig['betterAuth'] {
  return {
    secret: 'composition-runtime-secret-at-least-32-characters',
    mailMode,
    providers: {},
  };
}

function compose(
  input: Partial<
    Omit<Parameters<typeof composeBetterAuthRuntime>[0], 'config'>
  > & {
    betterAuth: ApiIdentityConfig['betterAuth'];
  },
) {
  const acquired: unknown[] = [];
  const { betterAuth: configured, ...overrides } = input;
  const runtime = composeBetterAuthRuntime({
    config: {
      publicWebOrigin: 'https://app.example.test',
      session,
      betterAuth: configured,
    },
    databaseConfig,
    runtime: undefined,
    authenticationMail: undefined,
    acquire: (resource) => {
      acquired.push(resource);
      return resource;
    },
    ...overrides,
  });
  return { runtime, acquired };
}

afterEach(() => {
  created.length = 0;
});

describe('Better Auth runtime composition', () => {
  it('lets an injected mailer win over the configured mail mode', () => {
    const mail: AuthenticationMail = {
      sendVerification: () => Promise.resolve(),
      sendPasswordReset: () => Promise.resolve(),
      sendEmailChangeConfirmation: () => Promise.resolve(),
    };

    const { runtime, acquired } = compose({
      betterAuth: betterAuth('durable'),
      authenticationMail: mail,
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.mail).toBe(mail);
    expect(created[0]).toMatchObject({
      baseUrl: 'https://app.example.test',
      trustedOrigins: ['https://app.example.test'],
      secureCookies: true,
      sessionTtlSeconds: 90,
    });
    expect(acquired).toEqual([runtime]);
  });

  it.each([
    [true, 1],
    [undefined, 0],
  ] as const)(
    'prints local mail links only when configured (%s)',
    async (printLocalMailLinks, writes) => {
      const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        compose({
          betterAuth: {
            ...betterAuth('local'),
            ...(printLocalMailLinks === undefined
              ? {}
              : { printLocalMailLinks }),
          },
        });
        const mail = created[0]?.mail;
        expect(mail).toBeInstanceOf(LocalAuthenticationMailSink);

        await mail?.sendVerification({
          recipient: 'ada@example.test',
          displayName: 'Ada',
          url: 'http://127.0.0.1:5173/verify-email?token=local-proof',
        });

        expect(write).toHaveBeenCalledTimes(writes);
        if (writes > 0)
          expect(write).toHaveBeenCalledWith(
            expect.stringContaining(
              'http://127.0.0.1:5173/verify-email?token=local-proof',
            ),
          );
      } finally {
        write.mockRestore();
      }
    },
  );

  it('seals durable mail with the configured key and owns its enqueue store', async () => {
    const { runtime, acquired } = compose({
      betterAuth: {
        ...betterAuth('durable'),
        durableMail: {
          fromEmail: 'security@example.test',
          encryption: {
            current: {
              version: 'auth-mail-v7',
              key: Buffer.alloc(32, 9).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });

    const mail = created[0]?.mail;
    expect(mail).toBeInstanceOf(DurableAuthenticationMail);
    const prepared = mail?.prepareProof?.({
      purpose: 'verification',
      recipient: 'person@example.test',
      displayName: 'Person',
      url: 'https://app.example.test/v1/auth/verify-email?token=proof',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(prepared?.sealedPayload.keyVersion).toBe('auth-mail-v7');
    expect(prepared?.sealedPayload.ciphertext).not.toContain('person@');
    expect(acquired).toHaveLength(2);
    expect(acquired[1]).toBe(runtime);
    await (acquired[0] as { close(): Promise<void> }).close();
  });

  it('fails before creating a runtime when durable mail has no settings', () => {
    expect(() => compose({ betterAuth: betterAuth('durable') })).toThrow(
      'Durable authentication mail is not configured',
    );
    expect(created).toEqual([]);
  });
});
