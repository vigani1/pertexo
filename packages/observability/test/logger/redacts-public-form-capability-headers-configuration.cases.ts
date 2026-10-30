import { expect, it } from 'vitest';

import {
  createStructuredLogger,
  redactLogText,
  redactCredentialFields,
} from '../../src/logger.js';
import { captureDestination, testConfig } from './fixture.js';

export function registerRedactsPublicFormCapabilityHeadersConfiguration(): void {
  it('redacts public form capability headers and configuration at every nesting level', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    logger.info('form.request', {
      request: {
        headers: {
          'x-pertexo-form-key': 'public-header-secret',
          'X-Pertexo-Unsubscribe-Key': 'unsubscribe-header-secret',
        },
      },
      nested: { capability: 'public-command-secret' },
    });
    expect(JSON.stringify(capture.records)).not.toContain(
      'public-header-secret',
    );
    expect(JSON.stringify(capture.records)).not.toContain(
      'unsubscribe-header-secret',
    );
    expect(JSON.stringify(capture.records)).not.toContain(
      'public-command-secret',
    );
  });

  it('redacts credential headers and secret fields at any depth and in any case', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    logger.info('request.received', {
      AUTHORIZATION: 'top-authorization-secret',
      'Set-Cookie': 'top-cookie-secret',
      req: { headers: { COOKIE: 'request-cookie-secret' } },
      response: { headers: { 'set-cookie': 'response-cookie-secret' } },
      a: { b: { c: { d: { e: { Password: 'deep-password-secret' } } } } },
      provider: { CLIENT_SECRET: 'snake-client-secret' },
      attempt: { sessionToken: 'session-token-secret' },
    });
    const written = JSON.stringify(capture.records);
    for (const secret of [
      'top-authorization-secret',
      'top-cookie-secret',
      'request-cookie-secret',
      'response-cookie-secret',
      'deep-password-secret',
      'snake-client-secret',
      'session-token-secret',
    ])
      expect(written).not.toContain(secret);
    expect(written).toContain('"event":"request.received"');
  });

  it('redacts URL-only webhook credentials in paths, URLs and errors', () => {
    const secret = 'a'.repeat(43);
    for (const text of [
      `POST /hooks/${secret}`,
      `https://api.example/hooks/${secret}?retry=1`,
      `Request failed: /hooks/${secret}`,
    ]) {
      const safe = redactLogText(text);
      expect(safe).not.toContain(secret);
      expect(safe).toContain('/hooks/[Redacted]');
    }
  });

  it('redacts credential fields and text with the same rules used for logs', () => {
    const input = {
      orderId: ' A-1042 ',
      empty: '',
      accessToken: 'opaque-secret',
      note: 'Bearer private-token',
    };
    const safe = redactCredentialFields(input);
    expect(safe.orderId).toBe(input.orderId);
    expect(safe.empty).toBe('');
    expect(safe.accessToken).toBe('[Redacted]');
    expect(safe.note).not.toContain('private-token');
    expect(input.accessToken).toBe('opaque-secret');
  });

  it('replaces a whole credential-bearing metadata value instead of expanding bounded text', () => {
    const value = 'Bearer ' + 'x'.repeat(248);
    expect(value.length).toBe(255);
    expect(redactCredentialFields({ order: value })).toEqual({
      order: '[Redacted]',
    });
  });
}
