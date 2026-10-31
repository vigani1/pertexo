import { expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api.js';
import {
  validDeployedEnvironment,
  standaloneBetterAuthEnvironment,
  deployedEnvironmentWithout,
} from './fixture.js';

export function registerRejectsSStandaloneBetterAuth(): void {
  it.each([
    [
      'an invitation key without its version',
      { INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64') },
      'Invitation token encryption configuration is incomplete',
    ],
    [
      'an invitation key version without its key',
      { INVITATION_TOKEN_KEY_VERSION: 'invite-v1' },
      'Invitation token encryption configuration is incomplete',
    ],
    [
      'a public web origin with a path',
      { PUBLIC_WEB_ORIGIN: 'https://app.example.test/app' },
      'PUBLIC_WEB_ORIGIN must be an origin without a path',
    ],
    [
      'durable mail settings while mail delivery is local',
      { AUTH_MAIL_FROM: 'security@example.test' },
      'Identity configuration is invalid',
    ],
    [
      'incomplete durable mail settings',
      { AUTH_MAIL_MODE: 'durable', AUTH_MAIL_FROM: 'security@example.test' },
      'Identity configuration is invalid',
    ],
    [
      'a social client ID without its secret',
      { AUTH_GOOGLE_CLIENT_ID: 'google-client' },
      'Identity configuration is invalid',
    ],
    [
      'a social client secret without its client ID',
      { AUTH_APPLE_CLIENT_SECRET: 'apple-secret' },
      'Identity configuration is invalid',
    ],
    [
      'malformed previous invitation keys',
      {
        INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'),
        INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
        INVITATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([{ version: 'v0' }]),
      },
      'Identity configuration is invalid',
    ],
  ])('rejects %s for standalone Better Auth', (_name, changed, message) => {
    expect(() =>
      parseApiConfig({ ...standaloneBetterAuthEnvironment(), ...changed }),
    ).toThrow(message);
  });

  it('requires Better Auth once any session setting enables identity', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        SESSION_TTL_MILLIS: '60000',
      }),
    ).toThrow('Better Auth configuration is incomplete');
  });

  it.each([
    [
      'an HTTP public web origin',
      { ...validDeployedEnvironment(), PUBLIC_WEB_ORIGIN: 'http://app.test' },
      'HTTPS public web origin is required when deployed',
    ],
    [
      'local authentication mail',
      {
        ...deployedEnvironmentWithout(
          'AUTH_MAIL_FROM',
          'AUTH_MAIL_KEY',
          'AUTH_MAIL_KEY_VERSION',
        ),
        AUTH_MAIL_MODE: 'local',
      },
      'Durable authentication mail is required when deployed',
    ],
    [
      'a missing Better Auth secret',
      deployedEnvironmentWithout('BETTER_AUTH_SECRET'),
      'Better Auth configuration is incomplete',
    ],
    [
      'a missing invitation token key',
      deployedEnvironmentWithout('INVITATION_TOKEN_KEY'),
      'Invitation token encryption configuration is incomplete',
    ],
  ])('rejects a deployment with %s', (_name, environment, message) => {
    expect(() => parseApiConfig(environment)).toThrow(message);
  });

  it('parses durable mail, invitation keys and every social provider', () => {
    const config = parseApiConfig({
      ...validDeployedEnvironment(),
      AUTH_GOOGLE_CLIENT_ID: 'google-client',
      AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
      AUTH_GITHUB_CLIENT_ID: 'github-client',
      AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
      AUTH_MICROSOFT_CLIENT_ID: 'microsoft-client',
      AUTH_MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
      AUTH_MICROSOFT_TENANT_ID: 'organizations',
      AUTH_APPLE_CLIENT_ID: 'apple-client',
      AUTH_APPLE_CLIENT_SECRET: 'apple-secret',
      INVITATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
        { version: 'invite-v0', key: Buffer.alloc(32, 5).toString('base64') },
      ]),
    });

    expect(config.identity?.betterAuth).toEqual({
      secret: 'better-auth-production-secret-at-least-32-characters',
      mailMode: 'durable',
      signUpMode: 'invitation',
      durableMail: {
        fromEmail: 'security@example.test',
        encryption: {
          current: {
            key: Buffer.alloc(32, 9).toString('base64'),
            version: 'auth-mail-v1',
          },
          previous: [],
        },
      },
      providers: {
        google: { clientId: 'google-client', clientSecret: 'google-secret' },
        github: { clientId: 'github-client', clientSecret: 'github-secret' },
        microsoft: {
          clientId: 'microsoft-client',
          clientSecret: 'microsoft-secret',
          tenantId: 'organizations',
        },
        apple: { clientId: 'apple-client', clientSecret: 'apple-secret' },
      },
    });
    expect(config.identity?.invitationTokenEncryption).toEqual({
      current: {
        version: 'invite-v1',
        key: Buffer.alloc(32, 8).toString('base64'),
      },
      previous: [
        { version: 'invite-v0', key: Buffer.alloc(32, 5).toString('base64') },
      ],
    });
    expect(Object.isFrozen(config.identity?.betterAuth.providers)).toBe(true);
    expect(Object.isFrozen(config.identity?.betterAuth.durableMail)).toBe(true);
  });

  it('keeps organization SSO off without a dedicated key and accepts a versioned key ring', () => {
    expect(
      parseApiConfig(standaloneBetterAuthEnvironment()).identity
        ?.federationEncryption,
    ).toBeUndefined();
    const key = Buffer.alloc(32, 0x57).toString('base64');
    const previous = {
      version: 'organization-v0',
      key: Buffer.alloc(32, 0x56).toString('base64'),
    };
    const config = parseApiConfig({
      ...standaloneBetterAuthEnvironment(),
      AUTH_FEDERATION_KEY: key,
      AUTH_FEDERATION_KEY_VERSION: 'organization-v1',
      AUTH_FEDERATION_PREVIOUS_KEYS: JSON.stringify([previous]),
    });
    expect(config.identity?.federationEncryption).toEqual({
      current: { version: 'organization-v1', key },
      previous: [previous],
    });
  });

  it.each([
    { AUTH_FEDERATION_KEY: 'private-invalid-key' },
    { AUTH_FEDERATION_KEY_VERSION: 'organization-v1' },
    { AUTH_FEDERATION_PREVIOUS_KEYS: 'private-invalid-json' },
    {
      AUTH_FEDERATION_KEY: 'private-invalid-key',
      AUTH_FEDERATION_KEY_VERSION: 'organization-v1',
    },
  ])(
    'refuses incomplete organization key configuration without exposing its value',
    (keys) => {
      expect(() =>
        parseApiConfig({ ...standaloneBetterAuthEnvironment(), ...keys }),
      ).toThrow('Identity configuration is invalid');
      try {
        parseApiConfig({ ...standaloneBetterAuthEnvironment(), ...keys });
      } catch (error: unknown) {
        expect(String(error)).not.toContain('private-invalid');
      }
    },
  );

  it('requires a public web origin when deployed', () => {
    expect(() =>
      parseApiConfig(deployedEnvironmentWithout('PUBLIC_WEB_ORIGIN')),
    ).toThrow('PUBLIC_WEB_ORIGIN is required for Better Auth');
  });
}
