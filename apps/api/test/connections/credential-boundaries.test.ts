import {
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
} from '@pertexo/contracts/connections';
import {
  resolvedHttpHeadersCredentialSchema,
  resolvedResendApiKeyCredentialSchema,
  resolvedSlackBotTokenCredentialSchema,
} from '@pertexo/integrations';
import { describe, expect, it } from 'vitest';

describe('connection credential boundary compatibility', () => {
  it.each([
    [
      'HTTP headers',
      httpHeadersCredentialSchema,
      resolvedHttpHeadersCredentialSchema,
      {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { 'X-Workspace': 'tenant-42', Authorization: 'Bearer secret' },
      },
    ],
    [
      'Slack bot token',
      slackBotTokenCredentialSchema,
      resolvedSlackBotTokenCredentialSchema,
      {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-secret',
      },
    ],
    [
      'Resend API key',
      resendApiKeyCredentialSchema,
      resolvedResendApiKeyCredentialSchema,
      {
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'Ops@Example.TEST',
      },
    ],
  ])(
    'keeps %s wire and resolved representations equivalent',
    (_, wire, resolved, value) => {
      expect(resolved.parse(value)).toEqual(wire.parse(value));
    },
  );

  it.each([
    [
      slackBotTokenCredentialSchema,
      resolvedSlackBotTokenCredentialSchema,
      {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxp-not-a-bot-token',
      },
    ],
    [
      resendApiKeyCredentialSchema,
      resolvedResendApiKeyCredentialSchema,
      {
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 'RE_not-a-resend-key',
        fromEmail: 'ops@example.test',
      },
    ],
    [
      resendApiKeyCredentialSchema,
      resolvedResendApiKeyCredentialSchema,
      {
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'Display Name <ops@example.test>',
      },
    ],
    [
      httpHeadersCredentialSchema,
      resolvedHttpHeadersCredentialSchema,
      {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Host: 'attacker.example.test' },
      },
    ],
  ])(
    'rejects the same invalid overlapping credential fields',
    (wire, resolved, value) => {
      expect(wire.safeParse(value).success).toBe(false);
      expect(resolved.safeParse(value).success).toBe(false);
    },
  );

  it('accounts for serialized header delimiters at both boundaries', () => {
    const value = {
      schemaVersion: 1,
      type: 'http_headers',
      headers: {
        'x-a': 'a'.repeat(8_187),
        'x-b': 'b'.repeat(8_187),
      },
    };

    expect(httpHeadersCredentialSchema.safeParse(value).success).toBe(false);
    expect(resolvedHttpHeadersCredentialSchema.safeParse(value).success).toBe(
      false,
    );
  });
});
