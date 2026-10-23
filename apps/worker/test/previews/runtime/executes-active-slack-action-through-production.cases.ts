import { randomUUID } from 'node:crypto';

import {
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
} from '@pertexo/integrations';

import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import { expect, it, vi } from 'vitest';

import { createPlatformPreviewNodeInvoker, leaseFixture } from './fixture.js';

export function registerExecutesActiveSlackActionThroughProduction(): void {
  it('executes the active Slack action through the production preview path', async () => {
    const connectionId = randomUUID();
    const secret = new TextEncoder().encode(
      JSON.stringify({
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-secret',
      }),
    );
    const beforeDispatch = vi.fn(() => Promise.resolve());
    const assertCurrent = vi.fn(() => Promise.resolve());
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
    const lease = {
      ...leaseFixture({
        config: { timeoutMillis: 5_000 },
        configVersion: 1,
        connectionRefs: {
          [SLACK_BOT_TOKEN_CONNECTION_SLOT]: connectionId,
        },
        definition: SLACK_SEND_MESSAGE_DEFINITION,
        id: 'node-1',
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: 'preview deployment' },
        },
      }),
      definitionKey: SLACK_SEND_MESSAGE_DEFINITION.key,
      dryRun: 'not_supported' as const,
      executorKey: SLACK_SEND_MESSAGE_EXECUTOR.key,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      sideEffectClass: 'unsafe' as const,
    };
    const invoker = createPlatformPreviewNodeInvoker({
      registry: createPlatformNodeRegistry({
        slackSendMessage: { client: { sendMessage } },
      }),
    });

    await expect(
      invoker.invoke({
        lease,
        runtime: {
          workspaceId: lease.workspaceId,
          runId: lease.previewRunId,
          nodeRunId: lease.previewAttemptId,
          attemptId: lease.previewAttemptId,
          attemptNumber: 1,
          nodeId: lease.nodeId,
          invocationKey: lease.nodeId,
          sideEffectClass: 'unsafe',
          beforeDispatch,
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'slack',
                authType: 'slack_bot_token',
                secretVersionId: randomUUID(),
                secret,
              }),
            assertCurrent,
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      output: {
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      },
      status: 'succeeded',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it.each(['core.wait', 'core.call'])(
    'rejects %s with a stable suspension-not-supported outcome',
    async (key) => {
      const execute = vi.fn();
      const invoker = createPlatformPreviewNodeInvoker({
        registry: { execute } as never,
      });
      const lease = {
        ...leaseFixture({
          config: { durationSeconds: 60 },
          configVersion: 1,
          connectionRefs: {},
          definition: { key, version: 1 },
          id: 'node-1',
          inputMappings: {},
        }),
        definitionKey: key,
        executorKey: key,
      };

      await expect(
        invoker.invoke({ lease, signal: new AbortController().signal }),
      ).resolves.toEqual({
        safeErrorCode: 'preview.suspension_not_supported',
        status: 'failed',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('resolves mappings through the production resolver before execution', async () => {
    const execute = vi.fn((request: { input: unknown }) =>
      Promise.resolve({ kind: 'succeeded' as const, output: request.input }),
    );
    const invoker = createPlatformPreviewNodeInvoker({
      registry: { execute } as never,
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {
        doubled: {
          expression: 'runInput.count * 2',
          kind: 'expression',
          language: 'jsonata',
        },
        name: { kind: 'run_input', path: '$.name' },
      },
    });

    await expect(
      invoker.invoke({
        lease,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      output: { doubled: 8, name: 'Ada' },
      status: 'succeeded',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { doubled: 8, name: 'Ada' } }),
    );
  });

  it('closes only after active invocation work settles and refuses later invocations', async () => {
    const executionStarted = Promise.withResolvers<undefined>();
    const finishExecution = Promise.withResolvers<undefined>();
    const invoker = createPlatformPreviewNodeInvoker({
      registry: {
        execute: async () => {
          executionStarted.resolve(undefined);
          await finishExecution.promise;
          return { kind: 'succeeded' as const, output: { ok: true } };
        },
      } as never,
    });
    const lease = leaseFixture({
      config: {},
      configVersion: 1,
      connectionRefs: {},
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {},
    });
    const invocation = invoker.invoke({
      lease,
      signal: new AbortController().signal,
    });
    await executionStarted.promise;

    const close = invoker.close?.();
    expect(close).toBeDefined();
    expect(invoker.close?.()).toBe(close);
    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({
      safeErrorCode: 'preview.invoker_closed',
      status: 'failed',
    });
    let closeSettled = false;
    void close?.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    finishExecution.resolve(undefined);
    await expect(invocation).resolves.toEqual({
      output: { ok: true },
      status: 'succeeded',
    });
    await close;
  });
}
