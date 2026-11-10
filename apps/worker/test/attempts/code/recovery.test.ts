import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import {
  NodeCodeFailure,
  readCodeFrame,
  writeCodeFrame,
} from '@pertexo/node-sdk/server';
import { expect, it } from 'vitest';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { context, databaseConfig } from '../runtime-capabilities.fixture.js';

it.each([false, true])(
  'Code recovery with prior dispatch %s never repeats an interrupted task',
  async (previouslyDispatched) => {
    const directory = await mkdtemp(join(tmpdir(), 'code-recovery-'));
    const socketPath = join(directory, 'runner.sock');
    const settings = { ...DEFAULT_CODE_SETTINGS, enabled: true };
    let executions = 0;
    const server = createServer((socket) => {
      void (async () => {
        await writeCodeFrame(socket, {
          kind: 'ready',
          mode: 'hardened',
          settings,
        });
        await readCodeFrame(socket, 16 * 1024, AbortSignal.timeout(2000));
        executions += 1;
        await writeCodeFrame(socket, {
          kind: 'succeeded',
          output: 'executed',
          diagnostics: { logs: [], truncated: false },
        });
      })().catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const runtime = await createWorkerNodeRuntimeCapabilities({
      database: databaseConfig,
      codeRunner: { settings, socketPath, requireHardened: true },
    });
    try {
      const code = runtime.factories.code?.({
        ...context,
        variables: {},
        previouslyDispatched,
      });
      if (code === undefined) throw new Error('Code capability missing');
      const result = await code.execute({
        code: "return 'executed';",
        input: null,
        signal: AbortSignal.timeout(2000),
      });
      if (previouslyDispatched) {
        expect(result).toMatchObject({
          kind: 'failed',
          code: 'code.runtime_error',
        });
        if (result.kind !== 'failed')
          throw new Error('Interrupted Code succeeded');
        expect(result.diagnostics.error?.message).toMatch(
          /interrupted.*rerun/iu,
        );
        expect(new NodeCodeFailure(result.code, result.diagnostics).kind).toBe(
          'failed',
        );
        expect(executions).toBe(0);
      } else {
        expect(result).toMatchObject({ kind: 'succeeded', output: 'executed' });
        expect(executions).toBe(1);
      }
    } finally {
      await runtime.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
