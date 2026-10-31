import { describe, expect, it } from 'vitest';

import {
  connectionCreateRequestSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
} from '../../src/schemas/connections.js';
import {
  oauth2AuthorizationStartResponseSchema,
  oauth2ConnectionResponseSchema,
  oauth2CredentialSchema,
} from '../../src/schemas/oauth2-connections.js';

import { connectionFields, consentSettings, grant } from './fixture.js';

describe('the OAuth2 credential', () => {
  const credential = {
    type: 'oauth2',
    settings: consentSettings,
    clientSecret: 'a+secret/value=',
  };

  it('needs the secret, as S22 says every settings change does', () => {
    expect(oauth2CredentialSchema.parse(credential)).toEqual(credential);
    const { clientSecret: _omitted, ...withoutSecret } = credential;
    expect(oauth2CredentialSchema.safeParse(withoutSecret).success).toBe(false);
    expect(
      oauth2CredentialSchema.safeParse({ ...credential, clientSecret: '' })
        .success,
    ).toBe(false);
    expect(
      oauth2CredentialSchema.safeParse({
        ...credential,
        clientSecret: 's'.repeat(1_025),
      }).success,
    ).toBe(false);
    expect(
      oauth2CredentialSchema.safeParse({
        ...credential,
        clientSecret: 'line\nbreak',
      }).success,
    ).toBe(false);
  });

  // Plan, "Deliberately not yet changed": these unions widen with the handler.
  it.fails('replaces through the one rotate route', () => {
    expect(
      connectionRotateSecretRequestSchema.safeParse({
        expectedSecretVersionId: connectionFields.secretVersionId,
        credential,
      }).success,
    ).toBe(true);
  });

  it.fails('creates through the http member of the one create route', () => {
    expect(
      connectionCreateRequestSchema.safeParse({
        providerKey: 'http',
        name: 'Operations API',
        credential,
      }).success,
    ).toBe(true);
  });

  // Plan, "Deliberately not yet changed": this also widens the auth type.
  it.fails('answers from the same connection response', () => {
    expect(
      connectionResponseSchema.safeParse({
        ...connectionFields,
        status: 'active',
        grant,
      }).success,
    ).toBe(true);
  });
});

describe('the OAuth2 connection response', () => {
  const parse = (value: unknown) =>
    oauth2ConnectionResponseSchema.safeParse(value).success;

  it('an active connection must have its grant', () => {
    expect(parse({ ...connectionFields, status: 'active', grant })).toBe(true);
    expect(parse({ ...connectionFields, status: 'active' })).toBe(false);
  });

  it.each(['reauthorization_required', 'revoked'])(
    'a %s connection can’t have one',
    (status) => {
      expect(parse({ ...connectionFields, status })).toBe(true);
      expect(parse({ ...connectionFields, status, grant })).toBe(false);
    },
  );

  it('has no field that could hold a secret or token', () => {
    const active = { ...connectionFields, status: 'active', grant };
    for (const secretField of [
      { clientSecret: 'x' },
      { accessToken: 'x' },
      { refreshToken: 'x' },
    ]) {
      expect(parse({ ...active, ...secretField })).toBe(false);
      expect(parse({ ...active, grant: { ...grant, ...secretField } })).toBe(
        false,
      );
      expect(
        parse({
          ...active,
          oauth2: { ...connectionFields.oauth2, ...secretField },
        }),
      ).toBe(false);
      expect(
        parse({
          ...active,
          oauth2: {
            ...connectionFields.oauth2,
            settings: { ...consentSettings, ...secretField },
          },
        }),
      ).toBe(false);
    }
  });

  it('is only ever an http oauth2 connection', () => {
    const active = { ...connectionFields, status: 'active', grant };
    expect(parse({ ...active, providerKey: 'slack' })).toBe(false);
    expect(parse({ ...active, authType: 'http_headers' })).toBe(false);
  });

  it('starts as consent or as a connected connection', () => {
    expect(
      oauth2AuthorizationStartResponseSchema.safeParse({
        kind: 'consent',
        authorizationUrl: 'https://id.example.com/authorize?state=x',
        expiresAt: '2026-10-31T10:10:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      oauth2AuthorizationStartResponseSchema.safeParse({
        kind: 'connected',
        connection: { ...connectionFields, status: 'active', grant },
      }).success,
    ).toBe(true);
    expect(
      oauth2AuthorizationStartResponseSchema.safeParse({
        kind: 'consent',
        authorizationUrl: 'https://id.example.com/authorize?state=x',
        expiresAt: '2026-10-31T10:10:00.000Z',
        state: 'x',
      }).success,
    ).toBe(false);
  });
});
