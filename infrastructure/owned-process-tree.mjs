import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `taskkill failed for process tree ${String(pid)} with exit ${String(result.status)}`,
      );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export async function terminateProcessTree(
  pid,
  signal = 'SIGTERM',
  graceMillis = 5_000,
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  signalProcessGroup(pid, signal);
  if (process.platform === 'win32') return;
  const waitUntilGone = async () => {
    const deadline = Date.now() + graceMillis;
    while (processGroupExists(pid) && Date.now() < deadline) await delay(25);
    return !processGroupExists(pid);
  };
  if (await waitUntilGone()) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (!(await waitUntilGone()))
    throw new Error(`Process group ${String(pid)} did not terminate`);
}

export class OwnedProcessSupervisor {
  #owned = new Map();
  #terminate;

  constructor(terminate = terminateProcessTree) {
    this.#terminate = terminate;
  }

  spawn(command, args, options = {}) {
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
    });
    if (child.pid !== undefined)
      this.#owned.set(child.pid, { child, termination: undefined });
    return child;
  }

  async release(child) {
    if (child.pid === undefined) return;
    const record = this.#owned.get(child.pid);
    if (record === undefined) return;
    record.termination ??= this.#terminate(child.pid);
    try {
      await record.termination;
    } catch (error) {
      record.termination = undefined;
      throw error;
    }
    this.#owned.delete(child.pid);
  }

  async terminateAll(signal = 'SIGTERM') {
    const records = [...this.#owned.entries()];
    const results = await Promise.allSettled(
      records.map(async ([pid, record]) => {
        record.termination ??= this.#terminate(pid, signal);
        try {
          await record.termination;
        } catch (error) {
          record.termination = undefined;
          throw error;
        }
        this.#owned.delete(pid);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, 'Owned process cleanup failed');
  }

  killAllSync() {
    for (const pid of this.#owned.keys()) signalProcessGroup(pid, 'SIGKILL');
  }
}

/**
 * Run one directly owned command through its complete lifecycle. The returned
 * promise settles only after direct-child exit, owned-descendant termination,
 * and output-pipe close. `onStdout`/`onStderr` own presentation or buffering;
 * this function owns ordering, cancellation cleanup, and combined command /
 * cleanup failure. A failed cleanup leaves ownership with the supervisor so a
 * later termination pass can retry it.
 */
export async function runManagedCommand({
  args,
  command,
  failure,
  onStarted,
  onStderr,
  onStdout,
  releaseOwned,
  spawnOptions,
  spawnOwned,
}) {
  const child = spawnOwned(command, args, spawnOptions);
  let exitResult;
  let commandError;
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => {
    const recordCommandError = (error) => {
      commandError ??= error;
      resolve();
    };
    const consumeOutput = (consumer) => (chunk) => {
      try {
        consumer?.(chunk);
      } catch (error) {
        recordCommandError(error);
      }
    };
    child.stdout?.on('data', consumeOutput(onStdout));
    child.stderr?.on('data', consumeOutput(onStderr));
    // Keep these listeners for the owned objects' lifetime. EventEmitter removes
    // a `once` listener after the first error, which would let a second stream
    // or child error escape before lifecycle settlement.
    child.stdout?.on('error', recordCommandError);
    child.stderr?.on('error', recordCommandError);
    child.on('error', recordCommandError);
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      if (commandError === undefined && code !== 0)
        commandError = failure(code, signal);
      resolve();
    });
    try {
      onStarted?.(child);
    } catch (error) {
      recordCommandError(error);
    }
  });

  let cleanupError;
  try {
    await releaseOwned(child);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const closeResult =
    cleanupError === undefined
      ? await closed
      : (exitResult ?? { code: null, signal: null });
  const result = {
    child,
    code: closeResult.code ?? exitResult?.code ?? null,
    signal: closeResult.signal ?? exitResult?.signal ?? null,
  };
  if (commandError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [commandError, cleanupError],
      `${command} failed and its process tree could not be cleaned up`,
    );
  if (commandError !== undefined) throw commandError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}
