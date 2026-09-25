import { describe, expect, it } from 'vitest';

import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from '../src/connections.js';
import {
  connectionCreateRequestSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  httpHeaderCredentialSchema,
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackChannelLookupQuerySchema,
  slackChannelLookupResponseSchema,
} from '../src/http/connections.js';

const connection = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  providerKey: 'http' as const,
  name: 'Operations API',
  authType: 'http_headers' as const,
  status: 'active' as const,
  secretVersionId: '00000000-0000-4000-8000-000000000003',
  health: {
    lastTestedAt: null,
    lastHealthyAt: null,
    lastErrorCode: null,
  },
  createdAt: '2026-08-22T18:00:00.000Z',
  updatedAt: '2026-08-22T18:00:00.000Z',
};

function exactByteUrl(character: string, bytesPerCharacter: number): string {
  const prefix = 'https://provider.example.test/';
  const remaining = 2_048 - Buffer.byteLength(prefix, 'utf8');
  const count = Math.floor(remaining / bytesPerCharacter);
  return `${prefix}${character.repeat(count)}${'a'.repeat(remaining - count * bytesPerCharacter)}`;
}

function issueMessages(value: unknown): readonly string[] {
  const result = connectionTestRequestSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success
    ? []
    : result.error.issues.map(({ message }) => message);
}

describe('connection public contracts', () => {
  it('normalizes credential names without admitting controlled or duplicate headers', () => {
    const parsed = connectionCreateRequestSchema.parse({
      providerKey: 'http',
      name: 'Operations API',
      credential: {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: 'Bearer opaque', 'X-API-Key': 'key' },
      },
    });
    expect(parsed.credential).toMatchObject({
      headers: { authorization: 'Bearer opaque', 'x-api-key': 'key' },
    });
    expect(httpHeaderCredentialSchema.safeParse({}).success).toBe(false);
    expect(
      httpHeaderCredentialSchema.safeParse({
        Authorization: 'first',
        authorization: 'second',
      }).success,
    ).toBe(false);
    for (const name of ['host', 'accept-encoding', 'idempotency-key'])
      expect(
        httpHeadersCredentialSchema.safeParse({
          schemaVersion: 1,
          type: 'http_headers',
          headers: { [name]: 'not-a-credential' },
        }).success,
      ).toBe(false);
  });

  it('enforces the aggregate credential bound independently of per-header bounds', () => {
    const exact = { 'x-a': 'a'.repeat(8_186), 'x-b': 'b'.repeat(8_186) };
    expect(httpHeaderCredentialSchema.safeParse(exact).success).toBe(true);

    const result = httpHeaderCredentialSchema.safeParse({
      ...exact,
      'x-b': 'b'.repeat(8_187),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: [],
          message: 'credential headers exceed the total byte limit',
        }),
      ]);
  });

  it('counts every UTF-8 code-point width at the exact URL byte boundary', () => {
    for (const [name, character, width] of [
      ['ASCII', 'a', 1],
      ['Latin-1', 'é', 2],
      ['three-byte BMP', '€', 3],
      ['unpaired-surrogate replacement', '\ud800', 3],
      ['supplementary', '😀', 4],
    ] as const) {
      const url = exactByteUrl(character, width);
      expect(Buffer.byteLength(url, 'utf8'), name).toBe(2_048);
      expect(connectionTestRequestSchema.safeParse({ url }).success, name).toBe(
        true,
      );
      if (width > 1) {
        const messages = issueMessages({ url: `${url}a` });
        expect(messages, name).toContain('URL exceeds byte limit');
      }
    }
  });

  it('keeps connection-test URL policy failures independent', () => {
    for (const request of [
      { url: 'http://provider.example.test/health' },
      { url: 'https://user:secret@provider.example.test/health' },
      { url: 'https://provider.example.test/health#secret' },
      { url: 'https://provider.example.test/health', extra: true },
    ])
      expect(connectionTestRequestSchema.safeParse(request).success).toBe(
        false,
      );
    expect(
      connectionTestRequestSchema.safeParse({
        url: 'https://provider.example.test/health',
      }).success,
    ).toBe(true);
  });

  it('accepts transport-safe Latin-1 values and rejects every forbidden control', () => {
    const forbidden = [
      ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
      0x7f,
    ].filter((codePoint) => codePoint !== 0x09);
    for (const codePoint of forbidden)
      expect(
        httpHeadersCredentialSchema.safeParse({
          schemaVersion: 1,
          type: 'http_headers',
          headers: {
            authorization: `left${String.fromCharCode(codePoint)}right`,
          },
        }).success,
      ).toBe(false);
    expect(
      httpHeadersCredentialSchema.parse({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { 'x-latin1': 'é', authorization: 'left\tright' },
      }).headers,
    ).toEqual({ authorization: 'left\tright', 'x-latin1': 'é' });
  });

  it('normalizes valid mailboxes and rejects one mailbox invariant at a time', () => {
    const credential = {
      schemaVersion: 1 as const,
      type: 'resend_api_key' as const,
      apiKey: 're_example_key',
    };
    expect(
      resendApiKeyCredentialSchema.parse({
        ...credential,
        fromEmail: 'Alerts@Example.COM',
      }).fromEmail,
    ).toBe('Alerts@example.com');
    for (const fromEmail of [
      'bad email@example.com',
      'missing-domain@example',
      'two@@example.com',
      `${'a'.repeat(65)}@example.com`,
      'alerts@-example.com',
      'invalid:mailbox@example.com',
    ])
      expect(
        resendApiKeyCredentialSchema.safeParse({ ...credential, fromEmail })
          .success,
      ).toBe(false);
  });

  it('bounds Slack channel lookups and keeps unresolved states honest', () => {
    expect(
      slackChannelLookupQuerySchema.parse({ channelIds: 'C0123,G456,D789' }),
    ).toEqual({ channelIds: ['C0123', 'G456', 'D789'] });
    const eleven = Array.from(
      { length: 11 },
      (_, index) => `C${String(index)}`,
    );
    for (const channelIds of [
      '',
      'c0123',
      'C0123,C0123',
      'C0123,',
      eleven.join(','),
    ])
      expect(
        slackChannelLookupQuerySchema.safeParse({ channelIds }).success,
      ).toBe(false);
    expect(
      slackChannelLookupQuerySchema.safeParse({
        channelIds: 'C0123',
        extra: 'x',
      }).success,
    ).toBe(false);
    const resolved = { channelId: 'C0123', status: 'resolved', name: 'ops' };
    const unresolved = {
      channelId: 'D0123',
      status: 'unresolved',
      reason: 'not_a_channel',
    };
    expect(
      slackChannelLookupResponseSchema.parse({ items: [resolved, unresolved] }),
    ).toEqual({ items: [resolved, unresolved] });
    for (const item of [
      { ...resolved, reason: 'not_found' },
      { ...unresolved, name: 'ops' },
      { ...unresolved, reason: 'token_revoked' },
      { ...resolved, name: '' },
    ])
      expect(
        slackChannelLookupResponseSchema.safeParse({ items: [item] }).success,
      ).toBe(false);
    expect(connectionsClientContract.schemas).toHaveProperty(
      'SlackChannelLookupResponse',
    );
  });

  it('publishes strict secret-free responses and the intended operations', () => {
    expect(
      connectionResponseSchema.safeParse({
        ...connection,
        credential: { authorization: 'must-not-leak' },
      }).success,
    ).toBe(false);
    expect(
      connectionTestResponseSchema.safeParse({
        connection: {
          ...connection,
          health: {
            ...connection.health,
            lastTestedAt: '2026-08-22T18:00:00.000Z',
            lastHealthyAt: '2026-08-22T18:00:00.000Z',
          },
        },
        outcome: { ok: true, httpStatus: 204, errorCode: null },
      }).success,
    ).toBe(true);
    expect(connectionsClientContract.schemas).toHaveProperty(
      'ConnectionCreateRequest',
    );
    expect(Object.keys(connectionsOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/connections',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}/secret',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}/test',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}/slack/channels',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/versions',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/status',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/failure-notification-policy',
    ]);
    expect(
      connectionsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/connections'
      ].post.parameters.map(({ name }) => name),
    ).toEqual(['workspaceId', 'x-csrf-token', 'Idempotency-Key']);
    expect(
      connectionsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/connections'
      ].get.responses,
    ).toHaveProperty('404');
    expect(
      connectionsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/connections/{connectionId}/test'
      ].post.parameters.map(({ name }) => name),
    ).toEqual([
      'workspaceId',
      'connectionId',
      'x-csrf-token',
      'Idempotency-Key',
    ]);
  });
});
