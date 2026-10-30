import { isWebhookResponseHeaderAllowed } from '@pertexo/node-sdk';
import { describe, expect, it } from 'vitest';

import { CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA } from '../../src/flow/respond-webhook/validation.js';

describe('what a Respond to webhook step may ask a browser to do', () => {
  it.each([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xslt+xml',
    'application/rss+xml',
    'application/atom+xml',
    'application/mathml+xml',
    'multipart/x-mixed-replace',
    'text/javascript',
    'application/javascript',
  ])('refuses %s as a text body type', (textContentType) => {
    expect(
      CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA.safeParse({
        bodyType: 'text',
        textContentType,
      }).success,
    ).toBe(false);
  });

  it.each([
    'content-type',
    'content-disposition',
    'content-security-policy',
    'content-security-policy-report-only',
    'x-content-type-options',
    'x-frame-options',
    'x-xss-protection',
    'link',
    'refresh',
    'set-cookie',
    'location',
    'CONTENT-TYPE',
  ])('refuses %s as a mapped header', (name) => {
    expect(isWebhookResponseHeaderAllowed(name)).toBe(false);
  });
});
