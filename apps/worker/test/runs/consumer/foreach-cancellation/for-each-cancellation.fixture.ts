import type { ChildProcess } from 'node:child_process';

import { describe } from 'vitest';
import { coordinatorFixture } from '../../../support/coordinator/consumer.js';

export const {
  databaseUrl,
  dispatcherUrl,
  enabled,
  ownerQuery,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} = coordinatorFixture;

export const describeIntegration = enabled ? describe : describe.skip;

export const MAXIMUM_CHILD_OUTPUT_BYTES = 64 * 1_024;

export type ChildExit = Readonly<{
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}>;

export type OwnedChild = Readonly<{
  child: ChildProcess;
  exit: Promise<ChildExit>;
}>;

export type ChildStage = 'loaded' | 'ready';

export type StartableChild = OwnedChild &
  Readonly<{
    start: () => Promise<void>;
  }>;

export const SPARE_WORKERS = 2;

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function stopOwnedChild(owner: OwnedChild): Promise<void> {
  if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
    const exited = await owner.exit;
    if (exited.error !== undefined) throw exited.error;
    return;
  }
  if (!owner.child.kill('SIGTERM'))
    throw new Error('For Each child rejected SIGTERM');
  try {
    const exited = await bounded(
      owner.exit,
      5_000,
      'For Each child ignored SIGTERM',
    );
    if (exited.error !== undefined) throw exited.error;
    if (exited.code !== 0)
      throw new Error(
        `For Each child stopped unsuccessfully (${String(exited.code)}, ${String(exited.signal)})`,
      );
  } catch (gracefulError: unknown) {
    if (childIsRunning(owner.child) && !owner.child.kill('SIGKILL'))
      throw new AggregateError(
        [gracefulError, new Error('For Each child rejected SIGKILL')],
        'For Each child termination failed',
      );
    const forcedExit = await bounded(
      owner.exit,
      5_000,
      'For Each child did not exit after SIGKILL',
    );
    if (forcedExit.error !== undefined)
      throw new AggregateError(
        [gracefulError, forcedExit.error],
        'For Each child termination failed',
      );
    throw gracefulError;
  }
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export async function discardSpares(
  spares: Promise<StartableChild>[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const spare of spares.splice(0)) {
    const owner = await spare.catch(() => undefined);
    if (owner === undefined || !childIsRunning(owner.child)) continue;
    // An unstarted spare exits when its start signal can never arrive.
    owner.child.stdin?.end();
    await bounded(owner.exit, 5_000, 'For Each spare did not exit')
      .then((exited) => {
        if (exited.error !== undefined) throw exited.error;
        if (exited.code !== 0)
          throw new Error(
            `For Each spare stopped unsuccessfully (${String(exited.code)}, ${String(exited.signal)})`,
          );
      })
      .catch(async (error: unknown) => {
        errors.push(error);
        await stopOwnedChild(owner).catch(() => undefined);
      });
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'For Each spare cleanup failed');
}
