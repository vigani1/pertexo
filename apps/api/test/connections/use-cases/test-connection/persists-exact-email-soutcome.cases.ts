import { expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import type { ConnectionEmailClient } from '../../../../src/connections/ports.js';

import {
  secretVersionId,
  sealed,
  record,
  activeAccess,
  persistence,
  command,
} from './fixture.js';

export function registerPersistsExactEmailSOutcome(): void {
  it.each([
    [
      'success',
      { kind: 'succeeded', emailId: 'email-id' },
      { ok: true, httpStatus: 200 },
    ],
    [
      'credential rejection',
      { kind: 'rejected', status: 401, error: 'invalid_api_key' },
      {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'provider rejection',
      { kind: 'rejected', status: 400, error: 'invalid_request' },
      {
        ok: false,
        httpStatus: 400,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'rate limit',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
      {
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      },
    ],
    [
      'invalid response',
      { kind: 'invalid_response' },
      {
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact email $s outcome',
    async (_name, providerResult, expected) => {
      const emailRecord = record({
        providerKey: 'email',
        authType: 'resend_api_key',
      });
      const store = persistence({
        resolveConnectionTestSecret: vi.fn(() =>
          Promise.resolve({
            connection: emailRecord,
            secretVersionId,
            sealed,
          }),
        ),
      });
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'resend_api_key',
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
        }),
      );
      const emailClient = {
        sendNotification: vi.fn<
          NonNullable<ConnectionEmailClient['sendNotification']>
        >(
          async (
            input: Parameters<ConnectionEmailClient['sendNotification']>[0],
          ) => {
            await input.beforeDispatch();
            return providerResult;
          },
        ),
      } satisfies ConnectionEmailClient;

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
          slackClient: undefined,
          emailClient: emailClient,
        },
      ).execute(
        command({
          providerKey: 'email',
          sideEffectDisclosureAccepted: true,
        }),
      );

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome.errorCode).toBe(
        expected.ok ? null : expected.errorCode,
      );
    },
  );
}
