import type { Stats } from 'node:fs';
import { removeStaleSocket } from './socket-file.js';
import { createServer, type Socket } from 'node:net';
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CODE_LIMITS,
  codeTaskSchema,
  type CodeResult,
} from '@pertexo/node-sdk';
import type { RunnerConfig } from '../config.js';
import type { createTaskProcessPool } from '../process/pool.js';
import {
  readCodeFrame as readFrame,
  writeCodeFrame as writeFrame,
} from '@pertexo/node-sdk/server';

export async function listenForCodeTasks(
  config: RunnerConfig,
  pool: Awaited<ReturnType<typeof createTaskProcessPool>>,
) {
  const directory = dirname(config.socketPath);
  await mkdir(directory, {
    recursive: true,
    mode: config.mode === 'hardened' ? 0o770 : 0o700,
  });
  const owner = await lstat(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.())
    throw new Error('Code socket directory must belong to its manager');
  if (config.mode === 'hardened') await chown(directory, 0, 10001);
  await chmod(directory, config.mode === 'hardened' ? 0o770 : 0o700);
  await removeStaleSocket(config.socketPath);
  const connections = new Set<Socket>();
  const jobs = new Set<Promise<void>>();
  const server = createServer((socket) => {
    connections.add(socket);
    const canceled = new AbortController();
    socket.on('error', () => {
      canceled.abort();
    });
    socket.once('close', () => {
      canceled.abort();
      connections.delete(socket);
    });
    const slot = config.settings.enabled ? pool.reserve() : undefined;
    const job = (async () => {
      try {
        await writeFrame(socket, {
          kind: slot === undefined ? 'busy' : 'ready',
          mode: config.mode,
          settings: config.settings,
        });
        if (slot === undefined) {
          socket.end(() => {
            socket.destroy();
          });
          return;
        }
        const admission = AbortSignal.any([
          canceled.signal,
          AbortSignal.timeout(5_000),
        ]);
        const task = codeTaskSchema.parse(
          await readFrame(socket, CODE_LIMITS.taskBytes, admission),
        );
        if (task.timeoutSeconds > config.settings.maximumSeconds)
          throw new Error('Code task exceeds instance time limit');
        const result = await slot.run(task, canceled.signal);
        if (!canceled.signal.aborted) await writeFrame(socket, result);
        socket.end(() => {
          socket.destroy();
        });
      } catch {
        if (!canceled.signal.aborted) {
          const failure: CodeResult = {
            kind: 'failed',
            code: 'code.runner_unavailable',
            diagnostics: {
              logs: [],
              truncated: false,
              error: { message: 'The Code runner could not accept this task.' },
            },
          };
          await writeFrame(socket, failure).catch(() => undefined);
        }
        socket.destroy();
      } finally {
        await slot?.release();
      }
    })();
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  });
  server.maxConnections = config.settings.concurrency + 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let identity: Stats | undefined;
  try {
    identity = await lstat(config.socketPath);
    await chmod(config.socketPath, config.mode === 'hardened' ? 0o660 : 0o600);
  } catch (error: unknown) {
    const stopped = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    for (const socket of connections) socket.destroy();
    await pool.close();
    await Promise.allSettled([...jobs]);
    await stopped;
    const current = await lstat(config.socketPath).catch(() => null);
    if (
      identity !== undefined &&
      current?.ino === identity.ino &&
      current.dev === identity.dev
    )
      await unlink(config.socketPath);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    close: (): Promise<void> =>
      (closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
        for (const socket of connections) socket.destroy();
        await pool.close();
        await Promise.allSettled([...jobs]);
        await stopped;
        const current = await lstat(config.socketPath).catch(() => null);
        if (current?.ino === identity.ino && current.dev === identity.dev)
          await unlink(config.socketPath);
      })()),
  };
}
