import { describe, expect, it } from 'vitest';
import {
  describeConnectionHealth,
  describeConnectionStatus,
  describeTestOutcome,
} from '@/features/connections/model/connection-health';
import { parseConnectionsSearch } from '@/features/connections/model/connections-search';
import {
  credentialErrors,
  describeSavedCredential,
  toCreateRequest,
  type CredentialDraft,
} from '@/features/connections/model/credential-draft';

const now = Date.parse('2026-09-24T12:00:00.000Z');

function health(
  overrides: Partial<{
    lastTestedAt: string | null;
    lastHealthyAt: string | null;
    lastErrorCode: string | null;
  }> = {},
) {
  return {
    lastTestedAt: null,
    lastHealthyAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

describe('connection health in words', () => {
  it('maps every status to one word and tone', () => {
    expect(describeConnectionStatus('active')).toEqual({
      tone: 'success',
      label: 'Active',
    });
    expect(describeConnectionStatus('reauthorization_required')).toEqual({
      tone: 'attention',
      label: 'Reconnect',
    });
    expect(describeConnectionStatus('revoked')).toEqual({
      tone: 'canceled',
      label: 'Revoked',
    });
  });

  it('turns the health projection into a sentence without codes', () => {
    const base = {
      providerKey: 'slack' as const,
      status: 'active' as const,
      updatedAt: '2026-09-24T10:00:00.000Z',
    };
    expect(
      describeConnectionHealth({ ...base, health: health() }, now),
    ).toEqual({
      text: 'never tested',
      tone: 'quiet',
    });
    expect(
      describeConnectionHealth(
        {
          ...base,
          health: health({
            lastTestedAt: '2026-09-24T10:00:00.000Z',
            lastHealthyAt: '2026-09-24T10:00:00.000Z',
          }),
        },
        now,
      ).text,
    ).toMatch(/^tested .+ · OK$/u);
    expect(
      describeConnectionHealth(
        {
          ...base,
          health: health({
            lastTestedAt: '2026-09-24T10:00:00.000Z',
            lastErrorCode: 'connection.credential_rejected',
          }),
        },
        now,
      ),
    ).toEqual({ text: 'last test failed · invalid token', tone: 'attention' });
    expect(
      describeConnectionHealth(
        {
          ...base,
          providerKey: 'http',
          health: health({ lastErrorCode: 'connection.test.ssrf_blocked' }),
        },
        now,
      ).text,
    ).toBe('last test failed · address not allowed');
  });

  it('explains a failed test and what to do next', () => {
    expect(
      describeTestOutcome('email', {
        ok: false,
        httpStatus: 403,
        errorCode: 'connection.credential_rejected',
      }).title,
    ).toBe('Resend rejected the API key.');
    expect(
      describeTestOutcome('http', {
        ok: false,
        httpStatus: null,
        errorCode: 'connection.test.timed_out',
      }),
    ).toEqual({
      title: 'The test failed: timed out.',
      detail: 'No answer arrived within 15 seconds.',
    });
    // A code the app doesn't know yet still reads as words, never the code.
    expect(
      describeTestOutcome('http', {
        ok: false,
        httpStatus: null,
        errorCode: 'http.request_failed',
      }).title,
    ).toBe('The test failed: request failed.');
    expect(
      describeConnectionHealth(
        {
          providerKey: 'http',
          status: 'active',
          health: health({ lastErrorCode: 'connection.test.tls_42' }),
          updatedAt: '2026-09-24T11:00:00.000Z',
        },
        now,
      ).text,
    ).toBe('last test failed · the service reported a problem');
  });

  it('summarises a saved credential without showing it whole', () => {
    expect(
      describeSavedCredential({
        provider: 'slack',
        botToken: 'xoxb-1-abcd4f2a',
      }),
    ).toEqual({ term: 'Token', value: 'xoxb-••••••••4f2a' });
    expect(
      describeSavedCredential({
        provider: 'email',
        apiKey: 're_live_9Qx1',
        fromEmail: 'billing@northwind.dev',
      }).value,
    ).toBe('re_••••••••9Qx1 · sends from billing@northwind.dev');
    expect(
      describeSavedCredential({
        provider: 'http',
        headers: [
          { id: 'a', name: 'Authorization', value: 'Bearer secret' },
          { id: 'b', name: '', value: '' },
        ],
      }),
    ).toEqual({ term: 'Header', value: 'Authorization' });
  });
});

describe('credential drafts', () => {
  it('names each Slack and Resend problem on its own field', () => {
    expect(credentialErrors({ provider: 'slack', botToken: ' ' })).toEqual({
      botToken: 'Paste the bot token from your Slack app.',
    });
    expect(
      credentialErrors({
        provider: 'email',
        apiKey: 'sk_live',
        fromEmail: 'billing@northwind',
      }),
    ).toEqual({
      apiKey: 'Resend API keys start with re_.',
      fromEmail:
        'That isn’t a complete email address, like alerts@yourdomain.com.',
    });
  });

  it('checks header rows, duplicates and transport-owned headers', () => {
    const draft = (
      rows: readonly (readonly [string, string])[],
    ): CredentialDraft => ({
      provider: 'http',
      headers: rows.map(([name, value], index) => ({
        id: String(index),
        name,
        value,
      })),
    });
    expect(credentialErrors(draft([['', '']]))).toEqual({
      'header-name:0': 'Add at least one header, like Authorization.',
    });
    expect(
      credentialErrors(
        draft([
          ['Authorization', 'Bearer a'],
          ['authorization', 'b'],
          ['X Team', ''],
        ]),
      ),
    ).toEqual({
      'header-name:1': 'This header is already listed.',
      'header-name:2':
        'Header names use letters, numbers and dashes, without spaces.',
      'header-value:2': 'Enter this header’s value.',
    });
    expect(credentialErrors(draft([['Host', 'example.test']]))).toEqual({
      'header-name:0': 'Pertexo sets this header itself. Use a different one.',
    });
  });

  it('builds the contract request with trimmed values and blank rows dropped', () => {
    expect(
      toCreateRequest('Billing API', {
        provider: 'http',
        headers: [
          { id: 'a', name: ' Authorization ', value: ' Bearer a ' },
          { id: 'b', name: '', value: '' },
        ],
      }),
    ).toEqual({
      providerKey: 'http',
      name: 'Billing API',
      credential: {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: 'Bearer a' },
      },
    });
  });
});

describe('connections URL state', () => {
  it('keeps only known lens and view values', () => {
    expect(
      parseConnectionsSearch({
        add: 'email',
        connection: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        view: 'revoked',
      }),
    ).toEqual({
      add: 'email',
      connection: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      view: 'revoked',
    });
    expect(
      parseConnectionsSearch({ add: 'ftp', connection: '1', view: 'all' }),
    ).toEqual({});
  });
});
