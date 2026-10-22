import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETTINGS, type CodeTask } from '@pertexo/node-sdk';
import { readCodeFrame, writeCodeFrame } from '@pertexo/node-sdk/server';
import { createCodeRunnerClient } from '../../../src/attempts/code/client.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const task: CodeTask = {
  code: 'return input;',
  timeoutSeconds: 1,
  input: { privateInput: 'workspace A' },
  variables: { PRIVATE_VALUE: 'workspace A' },
};
async function fixture(greeting: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-code-client-'));
  const socketPath = join(directory, 'runner.sock');
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('close', () => sockets.delete(socket));
    void writeCodeFrame(socket, greeting);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve();
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const client = createCodeRunnerClient({
    settings: DEFAULT_CODE_SETTINGS,
    socketPath,
    requireHardened: true,
  });
  cleanups.push(() => {
    client.close();
    return Promise.resolve();
  });
  return { client, received, server };
}
describe('worker Code transport boundary', () => {
  it('refuses mismatched Python allowlists before sending private data', async () => {
    const f = await fixture({
      kind: 'ready',
      mode: 'hardened',
      settings: { ...DEFAULT_CODE_SETTINGS, pythonPackages: ['unreviewed'] },
    });
    expect(
      await f.client.execute(
        { ...task, language: 'python' },
        AbortSignal.timeout(2000),
      ),
    ).toMatchObject({ kind: 'failed', code: 'code.runner_unavailable' });
    expect(Buffer.concat(f.received)).toHaveLength(0);
  });
  it('refuses a weak runner before sending input or variable data', async () => {
    const f = await fixture({
      kind: 'ready',
      mode: 'process',
      settings: DEFAULT_CODE_SETTINGS,
    });
    expect(
      await f.client.execute(task, AbortSignal.timeout(2000)),
    ).toMatchObject({ kind: 'failed', code: 'code.runner_unavailable' });
    expect(Buffer.concat(f.received)).toHaveLength(0);
  });
  it('refuses mismatched instance settings before sending private data', async () => {
    const f = await fixture({
      kind: 'ready',
      mode: 'hardened',
      settings: { ...DEFAULT_CODE_SETTINGS, memoryMiB: 256 },
    });
    expect(
      await f.client.execute(task, AbortSignal.timeout(2000)),
    ).toMatchObject({ kind: 'failed', code: 'code.runner_unavailable' });
    expect(Buffer.concat(f.received)).toHaveLength(0);
  });
  it('transports bounded input and captured variables after a hardened greeting', async () => {
    const f = await fixture({
      kind: 'ready',
      mode: 'hardened',
      settings: DEFAULT_CODE_SETTINGS,
    });
    f.server.on('connection', (socket) => {
      void (async () => {
        const received = await readCodeFrame(
          socket,
          3 * 1048576,
          AbortSignal.timeout(2000),
        );
        expect(received).toEqual(task);
        await writeCodeFrame(socket, {
          kind: 'succeeded',
          output: 42,
          diagnostics: { logs: [], truncated: false },
        });
      })();
    });
    expect(
      await f.client.execute(task, AbortSignal.timeout(2000)),
    ).toMatchObject({ kind: 'succeeded', output: 42 });
  });
  it('does not contact a runner when disabled or a retained step exceeds a lowered maximum', async () => {
    const disabled = createCodeRunnerClient({
      settings: { ...DEFAULT_CODE_SETTINGS, enabled: false },
      socketPath: '/unused',
      requireHardened: true,
    });
    const limited = createCodeRunnerClient({
      settings: DEFAULT_CODE_SETTINGS,
      socketPath: '/unused',
      requireHardened: true,
    });
    try {
      expect(
        await disabled.execute(task, AbortSignal.timeout(1000)),
      ).toMatchObject({ kind: 'failed', code: 'code.disabled' });
      expect(
        await limited.execute(
          { ...task, timeoutSeconds: 31 },
          AbortSignal.timeout(1000),
        ),
      ).toMatchObject({ kind: 'failed', code: 'code.disabled' });
    } finally {
      disabled.close();
      limited.close();
    }
  });
  it('closes an in-flight socket on cancellation', async () => {
    const f = await fixture({
      kind: 'ready',
      mode: 'hardened',
      settings: DEFAULT_CODE_SETTINGS,
    });
    const cancel = new AbortController();
    const result = f.client.execute(task, cancel.signal);
    setTimeout(() => {
      cancel.abort();
    }, 20);
    await expect(result).rejects.toThrow();
  });
});
