import { describe, expect, it, vi } from 'vitest';
import {
  NodeCodeFailure,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  CORE_CODE_CONFIG_SCHEMA,
  CORE_CODE_MANIFEST,
} from '../../src/index.js';
import { createCoreNodeRegistry } from '../../src/server.js';

const identity = { key: 'core.code', version: 1 };
const diagnostics = {
  logs: [{ level: 'info' as const, message: 'private log' }],
  truncated: false,
};
function fixture() {
  const execute = vi.fn().mockResolvedValue({
    kind: 'succeeded',
    output: { total: 6 },
    diagnostics,
  });
  const observeCodeDiagnostics = vi.fn();
  const runtime: NodeExecutionRuntime = {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'code',
    invocationKey: 'root',
    sideEffectClass: 'safe',
    beforeDispatch: vi.fn(),
    code: { execute },
    observeCodeDiagnostics,
  };
  const signal = new AbortController().signal;
  return {
    execute,
    observeCodeDiagnostics,
    signal,
    run: (config: unknown = { code: 'return input;' }) =>
      createCoreNodeRegistry().execute({
        definition: identity,
        executor: identity,
        config,
        input: { amount: 3 },
        runtime,
        signal,
      }),
  };
}
describe('Code execution capability', () => {
  it('is safe and delegates to the worker capability without evaluating source', async () => {
    expect(CORE_CODE_MANIFEST.retryClass).toBe('safe');
    const f = fixture();
    expect(await f.run({ code: 'while(true) {}', timeoutSeconds: 2 })).toEqual({
      kind: 'succeeded',
      output: { total: 6 },
    });
    expect(f.execute).toHaveBeenCalledWith({
      code: 'while(true) {}',
      timeoutSeconds: 2,
      input: { amount: 3 },
      signal: f.signal,
    });
    expect(f.observeCodeDiagnostics).toHaveBeenCalledWith(diagnostics);
  });
  it('uses the shared syntax and byte limits before dispatch', async () => {
    const f = fixture();
    await expect(f.run({ code: 'return (;' })).rejects.toMatchObject({
      code: 'invalid_config',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      CORE_CODE_CONFIG_SCHEMA.safeParse({
        code: "return '" + 'é'.repeat(32768) + "';",
      }).success,
    ).toBe(false);
  });
  it.each([
    'code.syntax_error',
    'code.runtime_error',
    'code.timeout',
    'code.memory_limit',
    'code.output_invalid',
    'code.module_refused',
    'code.disabled',
    'code.runner_unavailable',
  ] as const)(
    'preserves %s without disclosing user diagnostics as the error message',
    async (code) => {
      const f = fixture();
      const detail = {
        ...diagnostics,
        error: { message: 'user-private failure' },
      };
      f.execute.mockResolvedValue({
        kind: 'failed',
        code,
        diagnostics: detail,
      });
      let failure: unknown;
      try {
        await f.run();
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(NodeCodeFailure);
      expect(failure).toMatchObject({
        code,
        kind: code === 'code.runner_unavailable' ? 'retry' : 'failed',
        possiblyDispatched: false,
        diagnostics: detail,
      });
      expect((failure as Error).message).not.toContain('user-private');
      expect(f.observeCodeDiagnostics).toHaveBeenCalledWith(detail);
    },
  );
});
