import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '../../src/server.js';
const scope = {
  workspaceId: 'workspace',
  runId: 'run',
  nodeRunId: 'node-run',
  attemptId: 'attempt',
  attemptNumber: 1,
  nodeId: 'node',
  invocationKey: 'invocation',
  sideEffectClass: 'safe' as const,
  beforeDispatch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};
function fixture(
  credential: unknown = { type: 'hmac_key', signingKey: ' secret 😀\n' },
) {
  const bytes = new TextEncoder().encode(JSON.stringify(credential));
  const resolve = vi
    .fn<NonNullable<NodeExecutionRuntime['connections']>['resolve']>()
    .mockResolvedValue({
      connectionId: '11111111-1111-4111-8111-111111111111',
      providerKey: 'signing',
      authType: 'hmac_key',
      secretVersionId: 'version',
      secret: bytes,
    });
  const assertCurrent = vi
    .fn<
      NonNullable<
        NonNullable<NodeExecutionRuntime['connections']>['assertCurrent']
      >
    >()
    .mockResolvedValue(undefined);
  const runtime = { ...scope, connections: { resolve, assertCurrent } };
  const execute = (
    config: unknown = { algorithm: 'sha256', encoding: 'hex' },
    input: unknown = { value: 'hello' },
    override: Partial<NodeExecutionRuntime> = {},
  ) =>
    createCoreNodeRegistry().execute({
      definition: { key: 'core.hmac', version: 1 },
      executor: { key: 'core.hmac', version: 1 },
      config,
      input,
      connectionRefs: { hmac_key: '11111111-1111-4111-8111-111111111111' },
      signal: new AbortController().signal,
      runtime: { ...runtime, ...override },
    });
  return { bytes, resolve, assertCurrent, execute };
}
describe('encrypted HMAC', () => {
  it.each(['sha256', 'sha512'])(
    'signs exact bytes with %s after checking the current workspace connection',
    async (algorithm) => {
      for (const encoding of ['hex', 'base64'] as const) {
        const { bytes, resolve, assertCurrent, execute } = fixture();
        expect(await execute({ algorithm, encoding })).toMatchObject({
          output: {
            value: createHmac(algorithm, ' secret 😀\n')
              .update('hello')
              .digest(encoding),
          },
        });
        expect(resolve).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionId: '11111111-1111-4111-8111-111111111111',
            expectedProviderKey: 'signing',
            expectedAuthType: 'hmac_key',
            purpose: 'core.hmac.execute',
          }),
        );
        expect(assertCurrent).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionId: '11111111-1111-4111-8111-111111111111',
            secretVersionId: 'version',
          }),
        );
        expect(bytes.every((value) => value === 0)).toBe(true);
        expect(scope.beforeDispatch).not.toHaveBeenCalled();
      }
    },
  );
  it('never accepts a key in settings or input data', async () => {
    const { execute, resolve } = fixture();
    await expect(
      execute({ algorithm: 'sha256', encoding: 'hex', key: 'secret' }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(
      execute(undefined, { value: 'hello', key: 'secret' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('refuses missing capabilities and mismatched credentials without exposing them', async () => {
    const { execute, bytes } = fixture({ type: 'hmac_key', signingKey: '' });
    const result: unknown = await execute().catch((error: unknown) => error);
    expect(result).toMatchObject({
      safeErrorCode: 'utility.hmac_connection',
      possiblyDispatched: false,
    });
    expect(bytes.every((value) => value === 0)).toBe(true);
    await expect(
      fixture().execute(undefined, undefined, {
        connections: { resolve: fixture().resolve },
      }),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.hmac_connection' });
  });
  it('does not sign after revocation or a race with rotation and always clears plaintext', async () => {
    const { execute, assertCurrent, bytes } = fixture();
    assertCurrent.mockRejectedValue(new ProviderCredentialInvalidError());
    await expect(execute()).rejects.toMatchObject({
      safeErrorCode: 'utility.hmac_connection',
      kind: 'failed',
    });
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
  it.each([
    new Error('PRIVATE connection failure'),
    new ProviderExecutionRateLimitError(2),
  ])(
    'uses safe bounded retry for operational key-access failures',
    async (error) => {
      const { execute, resolve } = fixture();
      resolve.mockRejectedValue(error);
      const result: unknown = await execute().catch(
        (caught: unknown) => caught,
      );
      expect(result).toMatchObject({
        kind: 'retry',
        possiblyDispatched: false,
        safeErrorCode: 'utility.hmac_unavailable',
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );
  it('rejects a resolved credential bound to another connection or provider before signing', async () => {
    const { resolve, execute, assertCurrent, bytes } = fixture();
    resolve.mockResolvedValue({
      connectionId: '22222222-2222-4222-8222-222222222222',
      providerKey: 'http',
      authType: 'http_headers',
      secretVersionId: 'version',
      secret: bytes,
    });
    await expect(execute()).rejects.toMatchObject({
      safeErrorCode: 'utility.hmac_connection',
    });
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
  it('refuses malformed Unicode keys rather than replacing their bytes during UTF-8 encoding', async () => {
    const { execute, bytes } = fixture({
      type: 'hmac_key',
      signingKey: '\ud800',
    });
    await expect(execute()).rejects.toMatchObject({
      safeErrorCode: 'utility.hmac_connection',
    });
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
});
