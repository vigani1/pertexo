import { describe, expect, it } from 'vitest';

import { connectionFitsSlot } from '../../src/authoring/connections/contract.js';

const http = { providerKey: 'http', authType: 'http_headers' };
const slack = { providerKey: 'slack', authType: 'slack_bot_token' };

describe('which connection fits a step’s slot', () => {
  // D11: an HTTP step takes either way of signing in.
  it('lets headers and OAuth2 serve an HTTP slot', () => {
    expect(connectionFitsSlot(http, http)).toBe(true);
    expect(
      connectionFitsSlot({ providerKey: 'http', authType: 'oauth2' }, http),
    ).toBe(true);
  });

  it('asks every other slot for its own provider and type', () => {
    expect(connectionFitsSlot(slack, slack)).toBe(true);
    expect(connectionFitsSlot(http, slack)).toBe(false);
    expect(
      connectionFitsSlot({ providerKey: 'slack', authType: 'oauth2' }, slack),
    ).toBe(false);
    expect(
      connectionFitsSlot({ providerKey: 'http', authType: 'hmac_key' }, http),
    ).toBe(false);
  });

  // OAuth2 only widens the HTTP slot: a provider's token can't pass for HTTP's.
  it('keeps the provider part of the rule', () => {
    expect(
      connectionFitsSlot({ providerKey: 'slack', authType: 'oauth2' }, http),
    ).toBe(false);
    expect(
      connectionFitsSlot(
        { providerKey: 'http', authType: 'oauth2' },
        { providerKey: 'http', authType: 'oauth2' },
      ),
    ).toBe(true);
  });
});
