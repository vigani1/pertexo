import { describe, expect, it } from 'vitest';

import {
  draftFromSettings,
  emptyOAuth2Draft,
  toOAuth2Credential,
  type OAuth2Draft,
} from '@/features/connections/model/oauth2-draft';
import {
  oauth2ServiceOf,
  withOAuth2Service,
} from '@/features/connections/model/oauth2-presets';

const typed = (draft: OAuth2Draft): OAuth2Draft => ({
  ...draft,
  clientId: 'my-client',
  clientSecret: 'my-secret',
});

const withTokenUrl = (tokenUrl: string): OAuth2Draft => ({
  ...emptyOAuth2Draft(),
  tokenUrl,
});

describe('a saved connection and its service', () => {
  // Nothing about the choice is stored, so what comes back has to read the same.
  it.each(['google', 'microsoft'] as const)(
    'reads %s again from its stored settings, with every field as it was',
    (service) => {
      const before = typed(withOAuth2Service(emptyOAuth2Draft(), service));

      const saved = toOAuth2Credential(before).settings;
      const after = draftFromSettings(saved);

      expect(oauth2ServiceOf(after)).toBe(service);
      expect(after).toEqual({ ...before, clientSecret: '' });
    },
  );

  it('reads as Other service for an address of anyone else', () => {
    expect(
      oauth2ServiceOf(withTokenUrl('https://auth.example.test/oauth/token')),
    ).toBe('custom');
    expect(oauth2ServiceOf(emptyOAuth2Draft())).toBe('custom');
    expect(oauth2ServiceOf(withTokenUrl('not an address'))).toBe('custom');
  });

  // The word "Google" on a form is a claim: a lookalike mustn't earn it.
  it.each([
    'https://oauth2.googleapis.com.example.test/token',
    'https://example.test/oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com@example.test/token',
    'https://login.microsoftonline.com.example.test/common/oauth2/v2.0/token',
    'https://example.test/login.microsoftonline.com/token',
  ])('doesn’t read %s as a known service', (address) => {
    expect(oauth2ServiceOf(withTokenUrl(address))).toBe('custom');
  });
});
