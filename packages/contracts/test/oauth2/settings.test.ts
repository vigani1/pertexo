import { describe, expect, it } from 'vitest';

import { oauth2ClientSettingsSchema } from '../../src/schemas/oauth2-connections.js';

import { consentSettings, serverSettings } from './fixture.js';

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

  // S10: sixteen largest parameters pass each limit but not the database's 16,384
  // bytes, so without a total the person gets a database failure, not a field error.
  it.fails('S10 refuses parameters too large to store, in total', () => {
    expect(
      accepts({
        ...consentSettings,
        tokenParameters: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            String(index).padStart(64, 'p'),
            'v'.repeat(1_024),
          ]),
        ),
      }),
    ).toBe(false);
  });

  it('S10 still takes one parameter of the largest size', () => {
    expect(
      accepts({
        ...consentSettings,
        tokenParameters: { ['p'.repeat(64)]: 'v'.repeat(1_024) },
      }),
    ).toBe(true);
  });

  it('refuses an unknown setting rather than dropping it', () => {
    expect(accepts({ ...consentSettings, clientSecret: 'hunter2' })).toBe(
      false,
    );
  });
});
