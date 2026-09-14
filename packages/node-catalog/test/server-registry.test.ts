import { describe, expect, it, vi } from 'vitest';
import {
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
} from '@pertexo/integrations';
import type {
  HttpRequestExecutorDependencies,
  SecureHttpBodyConsumer,
  SecureHttpRequest,
  SecureHttpResponse,
} from '@pertexo/integrations/server';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import {
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  CORE_SET_DEFINITION,
  CORE_SET_EXECUTOR,
} from '@pertexo/nodes-core';

import {
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
} from '../src/registry.js';
import { createPlatformNodeRegistryForRelease } from '../src/server.js';

describe('platform server registry composition', () => {
  it('constructs provider adapters only when the selected release requires them', () => {
    const coreProviderAccess = vi.fn(() => {
      throw new Error('core release must not access provider dependencies');
    });
    const coreDependencies = Object.defineProperties(
      {},
      {
        httpRequest: { get: coreProviderAccess },
        slackSendMessage: { get: coreProviderAccess },
        emailSendNotification: { get: coreProviderAccess },
      },
    );
    expect(() =>
      createPlatformNodeRegistryForRelease(
        CORE_REGISTRY_RELEASE_SUCCESSOR,
        coreDependencies,
      ),
    ).not.toThrow();
    expect(coreProviderAccess).not.toHaveBeenCalled();

    const unrelatedProviderAccess = vi.fn(() => {
      throw new Error('HTTP release must not access unrelated providers');
    });
    const httpDependencies = Object.defineProperties(
      { httpRequest: { httpClient: { executeStreaming: vi.fn() } as never } },
      {
        slackSendMessage: { get: unrelatedProviderAccess },
        emailSendNotification: { get: unrelatedProviderAccess },
      },
    );
    expect(() =>
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        httpDependencies,
      ),
    ).not.toThrow();
    expect(unrelatedProviderAccess).not.toHaveBeenCalled();
  });

  it('builds one exact active registry with dispatch-aware HTTP', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      { httpRequest: { httpClient: { executeStreaming: vi.fn() } as never } },
    );
    expect(registry.compatibility).toEqual({
      epoch: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.epoch,
      fingerprint: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.fingerprint,
    });
    expect(registry.historicalCatalog().definitions).toEqual(
      expect.arrayContaining([CORE_SET_DEFINITION, HTTP_REQUEST_DEFINITION]),
    );
    expect(
      registry.dispatchMode({
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
      }),
    ).toBe('before_execute');
    expect(
      registry.dispatchMode({
        definition: HTTP_REQUEST_DEFINITION,
        executor: HTTP_REQUEST_EXECUTOR,
      }),
    ).toBe('executor_controlled');
    await expect(
      registry.execute({
        definition: CORE_SET_DEFINITION,
        executor: CORE_SET_EXECUTOR,
        config: {},
        input: { value: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
  });

  it('rejects a staged registry and an unshipped identity', () => {
    expect(() =>
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
        { httpRequest: { httpClient: { executeStreaming: vi.fn() } as never } },
      ),
    ).toThrow(/cannot execute this release/u);
    const unshipped = createRegistryReleaseSuccessor({
      previous: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      epoch: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.epoch + 1,
      definitions: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.definitions.map(
        (manifest) =>
          manifest.definition.key === HTTP_REQUEST_DEFINITION.key
            ? { ...manifest, lifecycle: 'deprecated' as const }
            : manifest,
      ),
      executors: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.executors,
      policies: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.policies,
    });
    expect(() => createPlatformNodeRegistryForRelease(unshipped)).toThrow(
      'Platform compatibility release identity is not supported',
    );
  });

  it('executes the active email provider and clears its resolved secret', async () => {
    const sendNotification = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        };
      },
    );
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'sender@example.com',
      }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
      { emailSendNotification: { client: { sendNotification } } },
    );

    await expect(
      registry.execute({
        config: { timeoutMillis: 10_000 },
        definition: EMAIL_SEND_NOTIFICATION_DEFINITION,
        executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
        input: { toEmail: 'to@example.com', subject: 'Subject', text: 'Text' },
        connectionRefs: {
          [RESEND_API_KEY_CONNECTION_SLOT]:
            '22222222-2222-4222-8222-222222222222',
        },
        runtime: {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '33333333-3333-4333-8333-333333333333',
          nodeRunId: '44444444-4444-4444-8444-444444444444',
          attemptId: '55555555-5555-4555-8555-555555555555',
          attemptNumber: 1,
          nodeId: 'email',
          invocationKey: 'email',
          sideEffectClass: 'idempotent_with_key',
          providerIdempotencyKey: 'stable-resend-key',
          beforeDispatch: () => Promise.resolve(),
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId: '22222222-2222-4222-8222-222222222222',
                providerKey: 'email',
                authType: 'resend_api_key',
                secretVersionId: '66666666-6666-4666-8666-666666666666',
                secret,
              }),
            assertCurrent: () => Promise.resolve(),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
    });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('executes the active Slack provider and clears its resolved secret', async () => {
    const sendMessage = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          channelId: 'C123ABC',
          messageTs: '1724412345.000100',
        };
      },
    );
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-secret',
      }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
      { slackSendMessage: { client: { sendMessage } } },
    );

    await expect(
      registry.execute({
        config: { timeoutMillis: 10_000 },
        definition: SLACK_SEND_MESSAGE_DEFINITION,
        executor: SLACK_SEND_MESSAGE_EXECUTOR,
        input: { channelId: 'C123ABC', text: 'deployed' },
        connectionRefs: {
          [SLACK_BOT_TOKEN_CONNECTION_SLOT]:
            '22222222-2222-4222-8222-222222222222',
        },
        runtime: {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '33333333-3333-4333-8333-333333333333',
          nodeRunId: '44444444-4444-4444-8444-444444444444',
          attemptId: '55555555-5555-4555-8555-555555555555',
          attemptNumber: 1,
          nodeId: 'slack',
          invocationKey: 'slack',
          sideEffectClass: 'unsafe',
          beforeDispatch: () => Promise.resolve(),
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId: '22222222-2222-4222-8222-222222222222',
                providerKey: 'slack',
                authType: 'slack_bot_token',
                secretVersionId: '66666666-6666-4666-8666-666666666666',
                secret,
              }),
            assertCurrent: () => Promise.resolve(),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { channelId: 'C123ABC', messageTs: '1724412345.000100' },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('threads provider telemetry through the active HTTP registry', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { authorization: 'Bearer telemetry-proof' },
      }),
    );
    const executeStreaming = async <Body>(
      request: SecureHttpRequest,
      consume: SecureHttpBodyConsumer<Body>,
    ): Promise<SecureHttpResponse<Body>> => {
      await request.beforeDispatch();
      const signal = request.signal ?? new AbortController().signal;
      const body = await consume({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new TextEncoder().encode('{"ok":true}');
        })(),
        bodyEncoding: 'utf8',
        finalUrl: 'https://provider.example.test',
        redirectCount: 0,
        signal,
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        bodyEncoding: 'utf8',
        finalUrl: 'https://provider.example.test',
        redirectCount: 0,
      };
    };
    const measure = vi.fn<
      NonNullable<HttpRequestExecutorDependencies['telemetry']>['measure']
    >((work) => work());
    const beforeDispatch = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      workspaceId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      nodeRunId: '44444444-4444-4444-8444-444444444444',
      attemptId: '55555555-5555-4555-8555-555555555555',
      attemptNumber: 1,
      nodeId: 'http',
      invocationKey: 'http-invocation',
      sideEffectClass: 'unsafe',
      beforeDispatch,
      connections: {
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        resolve: vi.fn().mockResolvedValue({
          connectionId,
          providerKey: 'http',
          authType: 'http_headers',
          secretVersionId: '66666666-6666-4666-8666-666666666666',
          secret,
        }),
      },
    } satisfies NodeExecutionRuntime;
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      {
        httpRequest: { httpClient: { executeStreaming } },
        httpRequestTelemetry: { measure },
      },
    );

    await expect(
      registry.execute({
        definition: HTTP_REQUEST_DEFINITION,
        executor: HTTP_REQUEST_EXECUTOR,
        config: {
          method: 'GET',
          url: 'https://provider.example.test/v1/items',
          headers: { accept: 'application/json' },
          timeoutMillis: 10_000,
          maxRedirects: 2,
          maxResponseBytes: 1_048_576,
          inlineResponseBytes: 65_536,
        },
        input: {},
        connectionRefs: { http_headers: connectionId },
        runtime,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      output: { body: { kind: 'inline', value: '{"ok":true}' } },
    });
    expect(measure).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });
});
