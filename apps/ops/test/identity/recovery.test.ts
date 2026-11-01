import { describe, expect, it, vi } from 'vitest';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import {
  authenticationMailAssociatedData,
  type SystemMailInput,
} from '@pertexo/secrets/server';
import type { TwoFactorRecoveryStore } from '@pertexo/core/tenant-access';
import { parseTwoFactorRecoveryConfig } from '../../src/identity/config.js';
import { disableTwoFactor } from '../../src/identity/run.js';

const environment = {
  DATABASE_URL:
    'postgresql://pertexo_app:private-database-password@localhost/pertexo',
  NODE_ENV: 'production',
  OPERATOR_ACTOR_REF: 'operator@example.test',
  OPERATOR_REASON: 'Verified account recovery',
  PUBLIC_WEB_ORIGIN: 'https://app.example.test',
  AUTH_MAIL_MODE: 'durable',
  AUTH_MAIL_FROM: 'security@example.test',
  AUTH_MAIL_KEY: Buffer.alloc(32, 0x67).toString('base64'),
  AUTH_MAIL_KEY_VERSION: 'mail-v1',
};
describe('privileged two-factor recovery', () => {
  it('needs existing app database and mail settings, without a factor, auth secret, workspace or telemetry configuration', () => {
    const config = parseTwoFactorRecoveryConfig(
      ['--email', 'ADA@example.test'],
      environment,
    );
    expect(config.email).toBe('ada@example.test');
    expect(config.database.max).toBe(1);
    expect(config.accountUrl).toBe('https://app.example.test/account/security');
    expect(
      parseTwoFactorRecoveryConfig(['--email', 'ada@example.test'], {
        ...environment,
        PUBLIC_WEB_ORIGIN: 'https://app.example.test/',
      }).accountUrl,
    ).toBe(config.accountUrl);
    expect(() =>
      parseTwoFactorRecoveryConfig(
        ['--email', 'ada@example.test', '--backup-code', 'anything'],
        environment,
      ),
    ).toThrow('Two-factor recovery configuration is invalid');
  });
  it.each([
    { AUTH_MAIL_MODE: 'local' },
    { AUTH_MAIL_KEY: undefined },
    { DATABASE_URL: 'not-a-database-url' },
    { OPERATOR_ACTOR_REF: undefined },
    { OPERATOR_REASON: '' },
    { PUBLIC_WEB_ORIGIN: 'http://app.example.test' },
  ])(
    'refuses incomplete or unsafe deployed configuration without exposing credentials: %j',
    (overrides) => {
      expect(() =>
        parseTwoFactorRecoveryConfig(['--email', 'ada@example.test'], {
          ...environment,
          ...overrides,
        }),
      ).toThrow('Two-factor recovery configuration is invalid');
      try {
        parseTwoFactorRecoveryConfig(['--email', 'ada@example.test'], {
          ...environment,
          ...overrides,
        });
      } catch (error) {
        expect(String(error)).not.toContain('private-database-password');
        expect(String(error)).not.toContain(environment.AUTH_MAIL_KEY);
      }
    },
  );
  it('seals the operator notice with the existing queue identity and prints only the recovery result', async () => {
    const config = parseTwoFactorRecoveryConfig(
      ['--email', 'ada@example.test'],
      environment,
    );
    let prepared: SystemMailInput | undefined;
    const store: TwoFactorRecoveryStore = {
      disable: vi.fn<TwoFactorRecoveryStore['disable']>(
        (email, prepareNotice) => {
          prepared = prepareNotice({ email, displayName: 'Ada' });
          return Promise.resolve({ status: 'disabled', email });
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const result = await disableTwoFactor(config, store);
    expect(result).toMatchObject({
      status: 'disabled',
      email: 'ada@example.test',
      securityNotice: 'queued',
      actorRef: environment.OPERATOR_ACTOR_REF,
    });
    if (prepared === undefined || config.mail.mode !== 'durable')
      throw new Error('Notice missing');
    expect(prepared.purpose).toBe('two_factor_disabled');
    const text = createApplicationSecretEnvelope(config.mail.encryption).open(
      prepared.sealedPayload,
      authenticationMailAssociatedData(
        prepared.purpose,
        prepared.id,
        prepared.expiresAt,
      ),
    );
    expect(JSON.parse(text)).toMatchObject({
      toEmail: 'ada@example.test',
      subject: 'An operator turned off two-factor sign-in',
    });
    expect(text).toContain('contact your Pertexo operator immediately');
    expect(text).not.toContain('ignore this message');
    expect(JSON.stringify(result)).not.toContain('ciphertext');
    expect(JSON.stringify(result)).not.toContain(environment.AUTH_MAIL_KEY);
  });
  it('keeps local development explicit and reports no mutation for an already-disabled account', async () => {
    const config = parseTwoFactorRecoveryConfig(
      ['--email', 'ada@example.test'],
      {
        ...environment,
        NODE_ENV: 'test',
        AUTH_MAIL_MODE: 'local',
        AUTH_MAIL_FROM: undefined,
        AUTH_MAIL_KEY: undefined,
        AUTH_MAIL_KEY_VERSION: undefined,
      },
    );
    const result = await disableTwoFactor(config, {
      disable: (email) => Promise.resolve({ status: 'already_off', email }),
      close: () => Promise.resolve(),
    });
    expect(result.status).toBe('already_off');
    expect(result).not.toHaveProperty('securityNotice');
  });
});
