import { describe, expect, it } from 'vitest';

import { parseInvitationDeliveryConfig } from '../src/config/invitation-delivery-config.js';

const tokenKey = Buffer.alloc(32, 8).toString('base64');
const invitationEnvironment = {
  INVITATION_EMAIL_API_KEY: 're_test',
  INVITATION_EMAIL_FROM: 'invites@example.test',
  INVITATION_TOKEN_KEY: tokenKey,
  INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
  PUBLIC_WEB_ORIGIN: 'https://app.example.test/',
} as const;

describe('parseInvitationDeliveryConfig', () => {
  it('stays absent when invitation delivery is neither enabled nor configured', () => {
    expect(parseInvitationDeliveryConfig({}, false, true)).toBeUndefined();
  });

  it('parses configured delivery into a normalized origin and key ring', () => {
    const config = parseInvitationDeliveryConfig(
      {
        ...invitationEnvironment,
        INVITATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
          { version: 'invite-v0', key: 'retired-key' },
        ]),
      },
      false,
      true,
    );

    expect(config).toEqual({
      apiKey: 're_test',
      fromEmail: 'invites@example.test',
      webOrigin: 'https://app.example.test',
      timeoutMillis: 5_000,
      tokenEncryption: {
        current: { version: 'invite-v1', key: tokenKey },
        previous: [{ version: 'invite-v0', key: 'retired-key' }],
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.tokenEncryption)).toBe(true);
  });

  it('requires complete configuration once invitation delivery is enabled', () => {
    expect(() => parseInvitationDeliveryConfig({}, true, false)).toThrow();
  });

  it('rejects a public web origin with a path', () => {
    expect(() =>
      parseInvitationDeliveryConfig(
        {
          ...invitationEnvironment,
          PUBLIC_WEB_ORIGIN: 'https://app.example.test/invitations',
        },
        true,
        false,
      ),
    ).toThrow('PUBLIC_WEB_ORIGIN must be an origin without a path');
  });

  it('requires an HTTPS public web origin only when deployed', () => {
    const localEnvironment = {
      ...invitationEnvironment,
      PUBLIC_WEB_ORIGIN: 'http://localhost:5173',
    };

    expect(
      parseInvitationDeliveryConfig(localEnvironment, true, false)?.webOrigin,
    ).toBe('http://localhost:5173');
    expect(() =>
      parseInvitationDeliveryConfig(localEnvironment, true, true),
    ).toThrow('HTTPS public web origin is required when deployed');
  });
});
