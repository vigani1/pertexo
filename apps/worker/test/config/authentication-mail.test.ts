import { describe, expect, it } from 'vitest';

import { parseSystemMailDeliveryConfig } from '../../src/config/system-mail.js';

const mailKey = Buffer.alloc(32, 4).toString('base64');
const configuredEnvironment = {
  AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
  AUTH_MAIL_KEY: mailKey,
  AUTH_MAIL_KEY_VERSION: 'mail-v1',
} as const;

describe('parseSystemMailDeliveryConfig', () => {
  it('stays absent for a local worker without authentication mail', () => {
    expect(parseSystemMailDeliveryConfig({}, false)).toBeUndefined();
  });

  it('applies bounded defaults and derives a dedicated worker identity', () => {
    const config = parseSystemMailDeliveryConfig(configuredEnvironment, false);

    expect(config).toEqual({
      delivery: { mode: 'resend', apiKey: 'provider-key' },
      timeoutMillis: 5_000,
      pollIntervalMillis: 1_000,
      workerId: 'auth-mail:worker-local',
      encryption: {
        current: { version: 'mail-v1', key: mailKey },
        previous: [],
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.encryption)).toBe(true);
    expect(Object.isFrozen(config?.encryption.current)).toBe(true);
  });

  it('parses explicit timing, worker identity and retired keys when deployed', () => {
    expect(
      parseSystemMailDeliveryConfig(
        {
          ...configuredEnvironment,
          AUTH_MAIL_FROM: 'security@example.test',
          PUBLIC_WEB_ORIGIN: 'https://app.example.test',
          AUTH_MAIL_EMAIL_TIMEOUT_MILLIS: '2500',
          AUTH_MAIL_POLL_MILLIS: '750',
          AUTH_MAIL_PREVIOUS_KEYS: JSON.stringify([
            { version: 'mail-v0', key: 'retired-key' },
          ]),
          WORKER_INSTANCE_ID: 'mail-worker-1',
        },
        true,
      ),
    ).toMatchObject({
      timeoutMillis: 2_500,
      pollIntervalMillis: 750,
      workerId: 'auth-mail:mail-worker-1',
      encryption: {
        previous: [{ version: 'mail-v0', key: 'retired-key' }],
      },
    });
  });

  it('requires authentication mail delivery in a deployed worker', () => {
    expect(() => parseSystemMailDeliveryConfig({}, true)).toThrow(
      'Deployed workers require system mail delivery',
    );
  });

  it.each([
    'AUTH_MAIL_EMAIL_API_KEY',
    'AUTH_MAIL_KEY',
    'AUTH_MAIL_KEY_VERSION',
  ] as const)('rejects a partial configuration with only %s', (name) => {
    expect(() =>
      parseSystemMailDeliveryConfig(
        { [name]: configuredEnvironment[name] },
        false,
      ),
    ).toThrow();
  });

  it.each([
    ['a missing provider key', { AUTH_MAIL_EMAIL_API_KEY: undefined }],
    ['a missing sealing key', { AUTH_MAIL_KEY: undefined }],
    ['an invalid key version', { AUTH_MAIL_KEY_VERSION: '-mail' }],
    ['a timeout below the floor', { AUTH_MAIL_EMAIL_TIMEOUT_MILLIS: '99' }],
    ['a poll interval above the cap', { AUTH_MAIL_POLL_MILLIS: '60001' }],
    ['an invalid worker identity', { WORKER_INSTANCE_ID: 'worker/1' }],
    [
      'an invalid retired key',
      { AUTH_MAIL_PREVIOUS_KEYS: JSON.stringify([{ version: 'v0' }]) },
    ],
  ])('rejects delivery with %s', (_label, override) => {
    expect(() =>
      parseSystemMailDeliveryConfig(
        { ...configuredEnvironment, ...override },
        false,
      ),
    ).toThrow();
  });
});
