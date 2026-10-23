import { expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import type { ConnectionSlackClient } from '../../../../src/connections/ports.js';

import {
  secretVersionId,
  sealed,
  record,
  activeAccess,
  persistence,
  command,
} from './fixture.js';

export function registerPersistsExactSlackSOutcome(): void {
  it.each([
    ['success', { kind: 'succeeded' }, { ok: true, httpStatus: 200 }],
    [
      'account inactive',
      { kind: 'rejected', error: 'account_inactive' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.slack_account_inactive',
        reauthorizationRequired: true,
      },
    ],
    [
      'invalid auth',
      { kind: 'rejected', error: 'invalid_auth' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'not authed',
      { kind: 'rejected', error: 'not_authed' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'token revoked',
      { kind: 'rejected', error: 'token_revoked' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.slack_token_revoked',
        reauthorizationRequired: true,
      },
    ],
    [
      'token expired',
      { kind: 'rejected', error: 'token_expired' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.slack_token_expired',
        reauthorizationRequired: true,
      },
    ],
    [
      'generic unauthorized',
      { kind: 'http_failure', status: 401 },
      {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'generic forbidden',
      { kind: 'http_failure', status: 403 },
      {
        ok: false,
        httpStatus: 403,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'generic HTTP throttle',
      { kind: 'http_failure', status: 429 },
      {
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      },
    ],
    [
      'provider rejection',
      { kind: 'rejected', error: 'team_disabled' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact Slack $s outcome',
    async (_name, providerResult, expected) => {
      const slackRecord = record({
        providerKey: 'slack',
        authType: 'slack_bot_token',
      });
      const store = persistence({
        resolveConnectionTestSecret: vi.fn(() =>
          Promise.resolve({
            connection: slackRecord,
            secretVersionId,
            sealed,
          }),
        ),
      });
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'slack_bot_token',
          botToken: 'xoxb-123456789-secret',
        }),
      );
      const slackClient = {
        authTest: vi.fn<
          NonNullable<Pick<ConnectionSlackClient, 'authTest'>['authTest']>
        >(async (input: Parameters<ConnectionSlackClient['authTest']>[0]) => {
          await input.beforeDispatch();
          return providerResult;
        }),
      } satisfies Pick<ConnectionSlackClient, 'authTest'>;

      const result = await new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        {
          encryption: {
            seal: vi.fn(),
            open: vi.fn(() => Promise.resolve(plaintext)),
          },
          httpClient: { execute: vi.fn() },
          applicationSecret: 'fixture-application-secret',
          telemetry: undefined,
          slackClient: slackClient,
        },
      ).execute(command({ providerKey: 'slack' }));

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome.errorCode).toBe(
        expected.ok ? null : expected.errorCode,
      );
    },
  );
}
