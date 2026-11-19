import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CODE_LIMITS,
  DEFAULT_CODE_SETTINGS,
  codeGreetingSchema,
  codeResultSchema,
  type CodeTask,
} from '@pertexo/node-sdk';
import { readCodeFrame, writeCodeFrame } from '@pertexo/node-sdk/server';
import { createTaskProcessPool } from '../dist/process/pool.js';
import { listenForCodeTasks } from '../dist/transport/server.js';
import { HARDENED_TASK_PATH } from '../dist/config/runner-config.js';

const GREETING_BYTES = 16 * 1_024;
const settings = { ...DEFAULT_CODE_SETTINGS, concurrency: 1 };
const busyFor = (millis: number, value: string): CodeTask => ({
  code: `const end = Date.now() + ${String(millis)}; while (Date.now() < end); return '${value}';`,
  timeoutSeconds: 5,
  input: null,
  variables: {},
});

describe('a runner with every slot busy', () => {
  let directory: string;
  let socketPath: string;
  let pool: Awaited<ReturnType<typeof createTaskProcessPool>>;
  let listener: Awaited<ReturnType<typeof listenForCodeTasks>>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pertexo-busy-runner-'));
    socketPath = join(directory, 'sockets', 'runner.sock');
    const config = {
      settings,
      mode: 'process' as const,
      socketPath,
      taskPath: process.env.PATH ?? HARDENED_TASK_PATH,
      inheritedVariableNames: [],
    };
    pool = await createTaskProcessPool(config);
    listener = await listenForCodeTasks(config, pool);
  });
  afterAll(async () => {
    await listener.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function open(): Promise<Socket> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return socket;
  }
  async function greeting(socket: Socket) {
    return codeGreetingSchema.parse(
      await readCodeFrame(socket, GREETING_BYTES, AbortSignal.timeout(20_000)),
    ).kind;
  }
  /** Waits out any queue: the slot an earlier task used is still being replaced. */
  async function admitted(socket: Socket) {
    const kind = await greeting(socket);
    return kind === 'queued' ? greeting(socket) : kind;
  }
  async function result(socket: Socket, task: CodeTask) {
    await writeCodeFrame(socket, task);
    return codeResultSchema.parse(
      await readCodeFrame(
        socket,
        CODE_LIMITS.resultBytes,
        AbortSignal.timeout(20_000),
      ),
    );
  }

  it('queues later tasks and runs each in arrival order once a slot frees', async () => {
    const first = await open();
    expect(await admitted(first)).toBe('ready');
    const firstResult = result(first, busyFor(1_000, 'first'));
    const second = await open();
    expect(await greeting(second)).toBe('queued');
    const third = await open();
    expect(await greeting(third)).toBe('queued');
    const order: string[] = [];
    const secondTurn = greeting(second).then((kind) => {
      order.push('second');
      return kind;
    });
    const thirdTurn = greeting(third).then((kind) => {
      order.push('third');
      return kind;
    });

    expect(await firstResult).toMatchObject({
      kind: 'succeeded',
      output: 'first',
    });
    expect(await secondTurn).toBe('ready');
    expect(await result(second, busyFor(200, 'second'))).toMatchObject({
      kind: 'succeeded',
      output: 'second',
    });
    expect(await thirdTurn).toBe('ready');
    expect(await result(third, busyFor(0, 'third'))).toMatchObject({
      kind: 'succeeded',
      output: 'third',
    });
    expect(order).toEqual(['second', 'third']);
    for (const socket of [first, second, third]) socket.destroy();
  });

  it('gives a queued task’s turn to the next one when it leaves', async () => {
    const first = await open();
    expect(await admitted(first)).toBe('ready');
    const firstResult = result(first, busyFor(500, 'first'));
    const leaving = await open();
    expect(await greeting(leaving)).toBe('queued');
    const staying = await open();
    expect(await greeting(staying)).toBe('queued');
    leaving.destroy();

    await firstResult;
    expect(await greeting(staying)).toBe('ready');
    expect(await result(staying, busyFor(0, 'staying'))).toMatchObject({
      kind: 'succeeded',
      output: 'staying',
    });
    for (const socket of [first, staying]) socket.destroy();
  });
});
