import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { vi } from 'vitest';
import { RESEND_API_KEY_CONNECTION_SLOT } from '../../src/index.js';

export const connectionId = '22222222-2222-4222-8222-222222222222';
export const secretVersionId = '33333333-3333-4333-8333-333333333333';
export const providerIdempotencyKey = 'pertexo:v1:resend:stable-key';
export const originalBinding =
  'email:sha256:0ce354bd20817f5bc1af31a6e1e49d96414a9b82ae484aec1486ae37761738ff';
export function runtime(
  clientResult: unknown,
  resolvedSecretVersionId = secretVersionId,
  providerDispatchBinding?: string,
  providerDispatchUnresolved?: true,
) {
  const secret = new TextEncoder().encode(
    JSON.stringify({
      type: 'resend_api_key',
      apiKey: 're_123456789_secret',
      fromEmail: 'Notifications@Example.COM',
    }),
  );
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const assertCurrent = vi.fn(() => Promise.resolve());
  const value: NodeExecutionRuntime = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '44444444-4444-4444-8444-444444444444',
    nodeRunId: '55555555-5555-4555-8555-555555555555',
    attemptId: '66666666-6666-4666-8666-666666666666',
    attemptNumber: 1,
    nodeId: 'email-node',
    invocationKey: 'email-node',
    sideEffectClass: 'idempotent_with_key',
    providerIdempotencyKey,
    ...(providerDispatchBinding === undefined
      ? {}
      : { providerDispatchBinding }),
    ...(providerDispatchUnresolved === undefined
      ? {}
      : { providerDispatchUnresolved }),
    beforeDispatch,
    connections: {
      assertCurrent,
      resolve: () =>
        Promise.resolve({
          connectionId,
          providerKey: 'email',
          authType: 'resend_api_key',
          secretVersionId: resolvedSecretVersionId,
          secret,
        }),
    },
  };
  const sendNotification = vi.fn(
    async (input: { beforeDispatch(): Promise<void> }) => {
      await input.beforeDispatch();
      if (clientResult instanceof Error) throw clientResult;
      return clientResult as never;
    },
  );
  return { assertCurrent, beforeDispatch, secret, sendNotification, value };
}
export function invocation(value: NodeExecutionRuntime) {
  return {
    config: { timeoutMillis: 10_000 },
    input: {
      toEmail: 'Recipient@example.com',
      subject: 'Deployment complete',
      text: 'Production is healthy.',
    },
    connectionRefs: { [RESEND_API_KEY_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: value,
  };
}
