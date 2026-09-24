import { describe, expect, it } from 'vitest';

import { parseAuthenticationMailDeliveryConfig } from '../src/config/authentication-mail-config.js';

const mailKey = Buffer.alloc(32, 4).toString('base64');
const enabledEnvironment = {
  AUTH_MAIL_DELIVERY_ENABLED: 'true',
  AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
  AUTH_MAIL_KEY: mailKey,
  AUTH_MAIL_KEY_VERSION: 'mail-v1',
} as const;

describe('parseAuthenticationMailDeliveryConfig', () => {
  it('stays absent for a local worker without authentication mail', () => {
    expect(parseAuthenticationMailDeliveryConfig({}, false)).toBeUndefined();
    expect(
      parseAuthenticationMailDeliveryConfig(
        { AUTH_MAIL_DELIVERY_ENABLED: 'false' },
        false,
      ),
    ).toBeUndefined();
  });

  it('applies bounded defaults and derives a dedicated worker identity', () => {
    const config = parseAuthenticationMailDeliveryConfig(
      enabledEnvironment,
      false,
    );

    expect(config).toEqual({
      apiKey: 'provider-key',
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
      parseAuthenticationMailDeliveryConfig(
        {
          ...enabledEnvironment,
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
    expect(() => parseAuthenticationMailDeliveryConfig({}, true)).toThrow(
      'Deployed workers require authentication mail delivery',
    );
    expect(() =>
      parseAuthenticationMailDeliveryConfig(
        { ...enabledEnvironment, AUTH_MAIL_DELIVERY_ENABLED: 'false' },
        true,
      ),
    ).toThrow('Deployed workers require authentication mail delivery');
  });

  it.each([
    'AUTH_MAIL_EMAIL_API_KEY',
    'AUTH_MAIL_KEY',
    'AUTH_MAIL_KEY_VERSION',
  ] as const)(
    'fails closed when %s is present while delivery is disabled',
    (name) => {
      expect(() =>
        parseAuthenticationMailDeliveryConfig(
          { [name]: enabledEnvironment[name] },
          false,
        ),
      ).toThrow('Authentication mail delivery configuration is inactive');
    },
  );

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
  ])('rejects enabled delivery with %s', (_label, override) => {
    expect(() =>
      parseAuthenticationMailDeliveryConfig(
        { ...enabledEnvironment, ...override },
        false,
      ),
    ).toThrow();
  });
});
