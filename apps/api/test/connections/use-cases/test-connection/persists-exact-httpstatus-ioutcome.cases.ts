import type { SecureHttpRequest } from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import type { ConnectionHttpClient } from '../../../../src/connections/ports.js';

import { activeAccess, persistence, command } from './fixture.js';

export function registerPersistsExactHTTPStatusIOutcome(): void {
  it.each([
    [200, { ok: true, httpStatus: 200 }],
    [299, { ok: true, httpStatus: 299 }],
    [
      400,
      {
        ok: false,
        httpStatus: 400,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      401,
      {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      403,
      {
        ok: false,
        httpStatus: 403,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      429,
      {
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      },
    ],
    [
      500,
      {
        ok: false,
        httpStatus: 500,
        errorCode: 'connection.provider_unavailable',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact HTTP status %i outcome',
    async (status, expected) => {
      const store = persistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'http_headers',
          headers: { authorization: 'Bearer secret' },
        }),
      );
      const httpClient = {
        execute: vi.fn<NonNullable<ConnectionHttpClient['execute']>>(
          async (input: SecureHttpRequest) => {
            await input.beforeDispatch();
            return {
              status,
              headers: {},
              body: new Uint8Array(),
              bodyEncoding: 'utf8' as const,
              finalUrl: input.url,
              redirectCount: 0,
            };
          },
        ),
      } satisfies ConnectionHttpClient;

      const result = await new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        {
          encryption: {
            seal: vi.fn(),
            open: vi.fn(() => Promise.resolve(plaintext)),
          },
          httpClient: httpClient,
          applicationSecret: 'fixture-application-secret',
        },
      ).execute(command({ url: 'https://provider.example.test/health' }));

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome).toEqual(
        expected.ok
          ? { ok: true, httpStatus: expected.httpStatus, errorCode: null }
          : {
              ok: false,
              httpStatus: expected.httpStatus,
              errorCode: expected.errorCode,
            },
      );
    },
  );
}
