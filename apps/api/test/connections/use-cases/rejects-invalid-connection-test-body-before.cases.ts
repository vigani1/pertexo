import type { SecureHttpRequest } from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';
import type {
  ConnectionHttpClient,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../../../src/connections/ports.js';
import {
  TestConnectionUseCase,
  type TestConnectionCommand,
} from '../../../src/connections/use-cases/management.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';
import {
  actor,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from '../support/use-case-fixture.js';

export function registerRejectsInvalidConnectionTestBodyBefore(): void {
  it('rejects an invalid connection-test body before claiming work', async () => {
    const testCommand: TestConnectionCommand = {
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-invalid',
      request: { url: 'http://provider.example.test/health' },
    };
    const store = connectionTestPersistence();
    const open = vi.fn();
    const execute = vi.fn();

    await expect(
      new TestConnectionUseCase(store, authorization(), {
        encryption: { open, seal: vi.fn() },
        httpClient: { execute },
        applicationSecret: 'fixture-application-secret',
      }).execute(testCommand),
    ).rejects.toMatchObject({ name: 'ZodError' });

    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

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

    const result = await new TestConnectionUseCase(store, access, {
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

  it('replays a completed test without decrypting or contacting the provider', async () => {
    const replay = {
      connection: record({
        lastTestedAt: new Date('2026-08-22T12:01:00.000Z'),
        lastHealthyAt: new Date('2026-08-22T12:01:00.000Z'),
      }),
      outcome: { ok: true as const, httpStatus: 200 },
    };
    const store = connectionTestPersistence({
      startConnectionTest: vi.fn().mockResolvedValue({
        kind: 'replay',
        result: replay,
      }),
    });
    const encryption = { seal: vi.fn(), open: vi.fn() };
    const httpClient = { execute: vi.fn() };

    const result = await new TestConnectionUseCase(store, authorization(), {
      encryption: encryption,
      httpClient: httpClient,
      applicationSecret: 'fixture-application-secret',
    }).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-replay',
      request: { url: 'https://provider.example.test/health' },
    });

    expect(result.outcome).toEqual({
      ok: true,
      httpStatus: 200,
      errorCode: null,
    });
    expect(encryption.open).not.toHaveBeenCalled();
    expect(httpClient.execute).not.toHaveBeenCalled();
  });

  it('tests a Slack bot token only through one fixed auth.test client call', async () => {
    const controller = new AbortController();
    const slackCredential = {
      type: 'slack_bot_token',
      botToken: 'xoxb-123456789-deeply-secret',
    } as const;
    const slackRecord = record({
      providerKey: 'slack',
      authType: 'slack_bot_token',
      name: 'Operations Slack',
    });
    const store = connectionTestPersistence({
      resolveConnectionTestSecret: vi.fn(() =>
        Promise.resolve({ connection: slackRecord, secretVersionId, sealed }),
      ),
      completeConnectionTest: vi.fn<
        ConnectionTestPersistence['completeConnectionTest']
      >((input) =>
        Promise.resolve({ connection: slackRecord, outcome: input.outcome }),
      ),
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(slackCredential));
    const authTest = vi.fn<ConnectionSlackClient['authTest']>(async (input) => {
      expect(input.botToken).toBe(slackCredential.botToken);
      expect(input.timeoutMillis).toBe(15_000);
      expect(input.signal).toBe(controller.signal);
      await input.beforeDispatch();
      return { kind: 'succeeded' };
    });

    const result = await new TestConnectionUseCase(store, authorization(), {
      encryption: {
        seal: vi.fn(),
        open: vi.fn(() => Promise.resolve(plaintext)),
      },
      httpClient: { execute: vi.fn() },
      applicationSecret: 'fixture-application-secret',
      telemetry: undefined,
      slackClient: { authTest },
    }).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-slack',
      request: { providerKey: 'slack' },
      signal: controller.signal,
    });

    expect(result.outcome).toEqual({
      ok: true,
      httpStatus: 200,
      errorCode: null,
    });
    expect(store.startConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedProviderKey: 'slack' }),
    );
    expect(authTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });
}
