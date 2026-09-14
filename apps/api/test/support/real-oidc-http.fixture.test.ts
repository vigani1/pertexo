import { describe, expect, it } from 'vitest';

import {
  parseSessionCookies,
  readSetCookieValue,
} from './real-oidc-http.fixture.js';

describe('real OIDC HTTP fixture cookie parsing', () => {
  it('parses encoded session and CSRF values from one combined scalar header', () => {
    expect(
      parseSessionCookies(
        'pertexo_session=session%2Fvalue; Path=/; HttpOnly,pertexo_csrf=csrf%20value; Path=/',
      ),
    ).toEqual({
      rawSession: 'session/value',
      csrf: 'csrf value',
      cookieHeader: 'pertexo_session=session/value; pertexo_csrf=csrf value',
    });
  });

  it('parses expected cookie names from an array while ignoring attributes and unrelated cookies', () => {
    expect(
      parseSessionCookies([
        'unrelated=value; Path=/',
        'pertexo_session=opaque-session; Path=/; Secure; HttpOnly',
        'pertexo_csrf=opaque-csrf; Path=/; Secure',
      ]),
    ).toEqual({
      rawSession: 'opaque-session',
      csrf: 'opaque-csrf',
      cookieHeader: 'pertexo_session=opaque-session; pertexo_csrf=opaque-csrf',
    });
  });

  it.each([
    { name: 'an undefined header', header: undefined },
    { name: 'a missing session', header: 'pertexo_csrf=value; Path=/' },
    { name: 'a missing CSRF cookie', header: 'pertexo_session=value; Path=/' },
  ])('fails safely for $name without echoing cookie material', ({ header }) => {
    try {
      parseSessionCookies(header);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('value');
      return;
    }
    throw new Error('Expected cookie parsing to fail');
  });

  it('requires the complete expected name and decodes its value', () => {
    expect(
      readSetCookieValue(
        ['pertexo_session_extra=wrong', 'pertexo_session=right%2Bvalue'],
        'pertexo_session',
      ),
    ).toBe('right+value');
  });
});
