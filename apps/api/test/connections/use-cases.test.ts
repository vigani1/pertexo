import { describe, expect, it, vi } from 'vitest';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpRequest,
} from '@pertexo/secrets/server';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionHttpClient } from '../../src/connections/ports.js';
import { TestConnectionService } from '../../src/connections/testing/test-connection.js';
import { authorizeWorkspace } from '../../src/authorization/index.js';
import {
  actor,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  workspaceId,
} from './support/use-case-fixture.js';

/**
 * Provider calls, replays, stored outcomes, a viewer's refusal, an SSRF block
 * and a wrong-provider test run end to end in provider-test.integration.test.ts,
 * and the outcome table in testing/outcomes.test.ts. These cases stay because
 * only a test holding the buffers can see them wiped, and no real stack
 * produces the abort race, a lost dispatch record or a corrupted secret on
 * demand.
 */
describe('connection testing use case', () => {
  it('decrypts just in time, commits dispatch evidence, and stores only a safe test result', async () => {
    const store = connectionTestPersistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'connection:use',
      access,
      disclosure: 'not_found',
    });
    let plaintext: Uint8Array | undefined;
    let responseBody: Uint8Array | undefined;
    const controller = new AbortController();
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() => {
        plaintext = new TextEncoder().encode(JSON.stringify(credential));
        return Promise.resolve(plaintext);
      }),
    };
    const httpClient = {
      execute: vi.fn<NonNullable<ConnectionHttpClient['execute']>>(
        async (input: SecureHttpRequest) => {
          expect(input).toMatchObject({
            url: 'https://provider.example.test/health',
            method: 'GET',
            headers: { authorization: 'Bearer deeply-secret-value' },
            sensitiveValues: ['Bearer deeply-secret-value'],
            signal: controller.signal,
          });
          await input.beforeDispatch();
          responseBody = new TextEncoder().encode('provider response');
          return {
            status: 204,
            headers: {},
            body: responseBody,
            bodyEncoding: 'utf8' as const,
            finalUrl: 'https://provider.example.test',
            redirectCount: 0,
          };
        },
      ),
    } satisfies ConnectionHttpClient;

    const result = await new TestConnectionService(store, access, {
      encryption: encryption,
      httpClient: httpClient,
      applicationSecret: 'fixture-application-secret',
    }).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
      connectionId,
      idempotencyKey: 'test-42',
      requestId: 'request-42',
      request: { url: 'https://provider.example.test/health' },
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      connection: { id: connectionId },
      outcome: { ok: true, httpStatus: 204, errorCode: null },
    });
    expect(store.markConnectionTestDispatched).toHaveBeenCalledOnce();
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.completeConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { ok: true, httpStatus: 204 } }),
    );
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
    expect(responseBody?.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('deeply-secret-value');
  });

  it('does not contact a provider when cancellation races decryption completion', async () => {
    const controller = new AbortController();
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode(JSON.stringify(credential));
    const execute = vi.fn();
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() => {
        controller.abort();
        return Promise.resolve(plaintext);
      }),
    };

    await expect(
      new TestConnectionService(store, authorization(), {
        encryption: encryption,
        httpClient: {
          execute,
        },
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-canceled-after-decryption',
        request: { url: 'https://provider.example.test/health' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(execute).not.toHaveBeenCalled();
    expect(store.markConnectionTestDispatched).not.toHaveBeenCalled();
    expect(store.completeConnectionTest).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('abandons the test when the client cannot record its dispatch', async () => {
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(credential))),
      ),
    };
    const markerStore = connectionTestPersistence();
    const markerClient = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
            'definite_failure',
            { possiblyDispatched: false },
          ),
        ),
    };
    await expect(
      new TestConnectionService(markerStore, authorization(), {
        encryption: encryption,
        httpClient: markerClient,
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-marker',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
    });
    expect(markerStore.completeConnectionTest).not.toHaveBeenCalled();
    expect(markerStore.abandonConnectionTest).toHaveBeenCalledOnce();
  });

  it('rejects a decrypted credential with a non-object JSON shape', async () => {
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode('null');
    const execute = vi.fn();

    await expect(
      new TestConnectionService(store, authorization(), {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() => Promise.resolve(plaintext)),
        },
        httpClient: { execute },
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'malformed-decrypted-credential',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);

    expect(execute).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });
});
