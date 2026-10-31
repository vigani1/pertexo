import { describe, expect, it } from 'vitest';

import {
  connectionCreateRequestSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
} from '../src/schemas/connections.js';
import {
  OAUTH2_CALLBACK_PATH,
  OAUTH2_LANDING_PATH,
  oauth2AuthorizationStartResponseSchema,
  oauth2CallbackLandingSchema,
  oauth2CallbackQuerySchema,
  oauth2CallbackStateSchema,
  oauth2ClientSettingsSchema,
  oauth2ConnectionErrorCodeSchema,
  oauth2ConnectionResponseSchema,
  oauth2CredentialSchema,
  oauth2StepFailureCodeSchema,
} from '../src/schemas/oauth2-connections.js';
import { API_PROBLEM_MANIFEST } from '../src/errors/api-problem.js';

const consentSettings = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'pertexo-client',
  scope: 'read write',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
} as const;

const serverSettings = {
  grantType: 'client_credentials',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'pertexo-client',
  scope: '',
  clientAuthentication: 'body',
  tokenParameters: {},
  requestHosts: { mode: 'listed', hosts: ['api.example.com', '*.example.net'] },
} as const;

const connectionFields = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  providerKey: 'http',
  name: 'Operations API',
  authType: 'oauth2',
  secretVersionId: '00000000-0000-4000-8000-000000000003',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
  oauth2: {
    settings: consentSettings,
    redirectUri: `https://pertexo.example.com${OAUTH2_CALLBACK_PATH}`,
  },
} as const;

const grant = {
  authorizedAt: '2026-10-31T10:00:00.000Z',
  accessTokenExpiresAt: null,
  renewable: true,
};

const STATE = `${'A'.repeat(22)}.${'b'.repeat(43)}`;

const accepts = (settings: unknown): boolean =>
  oauth2ClientSettingsSchema.safeParse(settings).success;

describe('OAuth2 client settings', () => {
  it('takes both grant types and shows the client ID, addresses and scope back', () => {
    expect(oauth2ClientSettingsSchema.parse(consentSettings)).toEqual(
      consentSettings,
    );
    expect(oauth2ClientSettingsSchema.parse(serverSettings)).toEqual(
      serverSettings,
    );
  });

  it('keeps authorization fields off a client-credentials connection', () => {
    expect(
      accepts({
        ...serverSettings,
        authorizationUrl: 'https://id.example.com/authorize',
      }),
    ).toBe(false);
    expect(accepts({ ...serverSettings, pkce: 's256' })).toBe(false);
  });

  // S14: anything but http and https, credentials, a fragment, over 2,048 bytes.
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/plain,token'],
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://id.example.com/token'],
    ['a username', 'https://user@id.example.com/token'],
    ['a password', 'https://user:pass@id.example.com/token'],
    ['a fragment', 'https://id.example.com/token#part'],
    ['an empty fragment', 'https://id.example.com/token#'],
    ['too many characters', `https://id.example.com/${'a'.repeat(2_049)}`],
    ['too many bytes', `https://id.example.com/${'é'.repeat(1_020)}`],
    ['not a URL', 'id.example.com/token'],
  ])('S14 refuses %s in both addresses', (_name, url) => {
    expect(accepts({ ...consentSettings, tokenUrl: url })).toBe(false);
    expect(accepts({ ...consentSettings, authorizationUrl: url })).toBe(false);
  });

  it('S14 leaves http and private hosts for the API to decide', () => {
    expect(
      accepts({ ...consentSettings, tokenUrl: 'http://10.0.0.5:8080/token' }),
    ).toBe(true);
    expect(
      accepts({ ...consentSettings, authorizationUrl: 'http://idp.lan/auth' }),
    ).toBe(true);
  });

  it('S14 accepts an address of exactly 2,048 bytes', () => {
    const origin = 'https://id.example.com/';
    const url = `${origin}${'a'.repeat(2_048 - origin.length)}`;
    expect(url).toHaveLength(2_048);
    expect(accepts({ ...consentSettings, tokenUrl: url })).toBe(true);
  });

  it.each([
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'code_challenge',
    'code_challenge_method',
  ])('S14 refuses %s in the authorization address query', (name) => {
    expect(
      accepts({
        ...consentSettings,
        authorizationUrl: `https://id.example.com/authorize?${name}=x`,
      }),
    ).toBe(false);
  });

  it.each([
    'grant_type',
    'code',
    'redirect_uri',
    'client_id',
    'client_secret',
    'refresh_token',
    'code_verifier',
    'scope',
  ])('S14 refuses %s in the token address query', (name) => {
    expect(
      accepts({
        ...consentSettings,
        tokenUrl: `https://id.example.com/token?${name}=x`,
      }),
    ).toBe(false);
  });

  it('S14 allows a provider parameter already in an address', () => {
    expect(
      accepts({
        ...consentSettings,
        tokenUrl: 'https://id.example.com/token?tenant=acme',
      }),
    ).toBe(true);
  });

  it.each([
    ['authorizationParameters', 'client_id'],
    ['authorizationParameters', 'STATE'],
    ['authorizationParameters', 'Redirect_Uri'],
    ['tokenParameters', 'client_secret'],
    ['tokenParameters', 'GRANT_TYPE'],
    ['tokenParameters', 'refresh_token'],
  ])('refuses the reserved name in %s: %s', (field, name) => {
    expect(accepts({ ...consentSettings, [field]: { [name]: 'x' } })).toBe(
      false,
    );
  });

  it('takes the extra parameters services need', () => {
    expect(
      accepts({
        ...consentSettings,
        authorizationParameters: { access_type: 'offline', prompt: 'consent' },
        tokenParameters: { audience: 'https://api.example.com' },
      }),
    ).toBe(true);
  });

  it('bounds extra parameters: 16 entries, 64 byte names, 1,024 byte values', () => {
    const entries = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `name${String(index)}`,
          'value',
        ]),
      );
    const withTokenParameters = (tokenParameters: unknown) =>
      accepts({ ...consentSettings, tokenParameters });
    expect(withTokenParameters(entries(16))).toBe(true);
    expect(withTokenParameters(entries(17))).toBe(false);
    expect(withTokenParameters({ ['n'.repeat(64)]: 'x' })).toBe(true);
    expect(withTokenParameters({ ['n'.repeat(65)]: 'x' })).toBe(false);
    expect(withTokenParameters({ name: 'v'.repeat(1_024) })).toBe(true);
    expect(withTokenParameters({ name: 'v'.repeat(1_025) })).toBe(false);
    expect(withTokenParameters({ 'bad name': 'x' })).toBe(false);
    expect(withTokenParameters({ name: 'line\nbreak' })).toBe(false);
  });

  it('offers no plain PKCE', () => {
    expect(accepts({ ...consentSettings, pkce: 'plain' })).toBe(false);
    expect(accepts({ ...consentSettings, pkce: 'none' })).toBe(true);
  });

  it('bounds the client ID and scope', () => {
    expect(accepts({ ...consentSettings, clientId: '' })).toBe(false);
    expect(accepts({ ...consentSettings, clientId: 'c'.repeat(512) })).toBe(
      true,
    );
    expect(accepts({ ...consentSettings, clientId: 'c'.repeat(513) })).toBe(
      false,
    );
    expect(accepts({ ...consentSettings, scope: 's'.repeat(2_048) })).toBe(
      true,
    );
    expect(accepts({ ...consentSettings, scope: 's'.repeat(2_049) })).toBe(
      false,
    );
    expect(accepts({ ...consentSettings, scope: 'a,b c' })).toBe(true);
  });

  it('S24 hosts: a name or one leading wildcard, unique, at most 32', () => {
    const listed = (hosts: readonly string[]) =>
      accepts({ ...consentSettings, requestHosts: { mode: 'listed', hosts } });
    expect(listed(['api.example.com', '*.example.com'])).toBe(true);
    expect(listed([])).toBe(false);
    expect(listed(['a.example.com', 'a.example.com'])).toBe(false);
    expect(listed(['a.*.example.com'])).toBe(false);
    expect(listed(['*'])).toBe(false);
    expect(listed(['API.example.com'])).toBe(false);
    expect(listed(['https://api.example.com'])).toBe(false);
    expect(listed(['api.example.com:443'])).toBe(false);
    expect(
      listed(
        Array.from({ length: 32 }, (_, index) => `h${String(index)}.test`),
      ),
    ).toBe(true);
    expect(
      listed(
        Array.from({ length: 33 }, (_, index) => `h${String(index)}.test`),
      ),
    ).toBe(false);
  });

  it('refuses an unknown setting rather than dropping it', () => {
    expect(accepts({ ...consentSettings, clientSecret: 'hunter2' })).toBe(
      false,
    );
  });
});

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

describe('the callback query', () => {
  const parse = (query: Record<string, unknown>) =>
    oauth2CallbackQuerySchema.safeParse(query);

  // S1: 22 base64url characters, a dot, then 43.
  it.each([
    ['too short a workspace', `${'A'.repeat(21)}.${'b'.repeat(43)}`],
    ['too short a secret', `${'A'.repeat(22)}.${'b'.repeat(42)}`],
    ['no dot', `${'A'.repeat(22)}${'b'.repeat(43)}`],
    ['base64 padding', `${'A'.repeat(22)}.${'b'.repeat(42)}=`],
    ['a plus sign', `${'A'.repeat(21)}+.${'b'.repeat(43)}`],
  ])('S1 refuses a state with %s', (_name, state) => {
    expect(oauth2CallbackStateSchema.safeParse(state).success).toBe(false);
  });

  it('takes a code', () => {
    expect(parse({ state: STATE, code: 'the-code' }).data).toEqual({
      kind: 'code',
      state: STATE,
      code: 'the-code',
    });
  });

  it('takes an error, and drops the provider’s description (S9)', () => {
    expect(
      parse({
        state: STATE,
        error: 'access_denied',
        error_description: 'private words',
      }).data,
    ).toEqual({ kind: 'error', state: STATE, error: 'access_denied' });
  });

  it('keeps a provider’s own extra parameters from failing it', () => {
    expect(
      parse({ state: STATE, code: 'the-code', iss: 'https://id.example.com' })
        .success,
    ).toBe(true);
  });

  it('refuses a code and an error together', () => {
    expect(
      parse({ state: STATE, code: 'the-code', error: 'access_denied' }).success,
    ).toBe(false);
  });

  it('refuses neither a code nor an error', () => {
    expect(parse({ state: STATE }).success).toBe(false);
  });

  it('refuses no state', () => {
    expect(parse({ code: 'the-code' }).success).toBe(false);
  });

  it.each([
    ['state', { state: [STATE, STATE], code: 'the-code' }],
    ['code', { state: STATE, code: ['one', 'two'] }],
    ['error', { state: STATE, error: ['one', 'two'] }],
  ])('refuses a repeated %s', (_name, query) => {
    expect(parse(query).success).toBe(false);
  });

  it('bounds the code and the error', () => {
    expect(parse({ state: STATE, code: 'c'.repeat(4_096) }).success).toBe(true);
    expect(parse({ state: STATE, code: 'c'.repeat(4_097) }).success).toBe(
      false,
    );
    expect(parse({ state: STATE, error: 'e'.repeat(64) }).success).toBe(true);
    expect(parse({ state: STATE, error: 'e'.repeat(65) }).success).toBe(false);
  });

  it('a landing names a connection unless it is invalid (S7)', () => {
    const ids = {
      workspaceId: connectionFields.workspaceId,
      connectionId: connectionFields.id,
    };
    for (const result of [
      'connected',
      'denied',
      'token_refused',
      'provider_unavailable',
    ]) {
      expect(
        oauth2CallbackLandingSchema.safeParse({ result, ...ids }).success,
      ).toBe(true);
      expect(oauth2CallbackLandingSchema.safeParse({ result }).success).toBe(
        false,
      );
    }
    expect(
      oauth2CallbackLandingSchema.safeParse({ result: 'invalid' }).success,
    ).toBe(true);
    expect(
      oauth2CallbackLandingSchema.safeParse({ result: 'invalid', ...ids })
        .success,
    ).toBe(false);
  });
});

describe('the names the plan fixes', () => {
  it('uses the paths people register', () => {
    expect(OAUTH2_CALLBACK_PATH).toBe('/v1/connections/oauth2/callback');
    expect(OAUTH2_LANDING_PATH).toBe('/connections/oauth2/finished');
  });

  it('lists every connection failure', () => {
    expect(oauth2ConnectionErrorCodeSchema.options).toEqual([
      'connection.oauth2_not_authorized',
      'connection.oauth2_grant_revoked',
      'connection.oauth2_client_rejected',
      'connection.oauth2_token_expired',
    ]);
  });

  it('lists every step failure', () => {
    expect(oauth2StepFailureCodeSchema.options).toEqual([
      'http.oauth2_not_connected',
      'http.oauth2_grant_revoked',
      'http.oauth2_client_rejected',
      'http.oauth2_token_expired',
      'http.oauth2_token_rate_limited',
      'http.oauth2_token_endpoint_unavailable',
      'http.oauth2_token_response_invalid',
      'http.oauth2_token_address_blocked',
      'http.oauth2_refresh_busy',
      'http.oauth2_host_not_allowed',
    ]);
  });

  it('gives the refused address 400 and the refused start 409', () => {
    expect(
      API_PROBLEM_MANIFEST['connection.oauth2_endpoint_refused'].status,
    ).toBe(400);
    expect(API_PROBLEM_MANIFEST['connection.oauth2_token_refused'].status).toBe(
      409,
    );
  });
});
