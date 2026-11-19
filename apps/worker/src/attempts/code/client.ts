import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CODE_LIMITS,
  codeGreetingSchema,
  codeResultSchema,
  type CodeGreeting,
  type CodeResult,
  type CodeTask,
  type CodeSettings,
} from '@pertexo/node-sdk';
import { readCodeFrame, writeCodeFrame } from '@pertexo/node-sdk/server';

/** How the worker reaches the Code runner: its greeting, a full queue, and a task's result. */
const RUNNER_CONNECTION = Object.freeze({
  // Only a runner whose queue is full is asked again; a queued task just waits.
  busyRetryDelayMillis: 1_000,
  greetingBytes: 16 * 1_024,
  greetingTimeoutMillis: 2_000,
  // The runner's own time limit ends the task first; this is only its margin.
  resultGraceSeconds: 2,
});

export type WorkerCodeRunnerConfig = Readonly<{
  settings: CodeSettings;
  socketPath: string;
  requireHardened: boolean;
}>;
const failed = (
  code: 'code.disabled' | 'code.runner_unavailable' | 'code.runner_busy',
  message: string,
): CodeResult => ({
  kind: 'failed',
  code,
  diagnostics: { logs: [], truncated: false, error: { message } },
});
const stayedBusy = () =>
  failed(
    'code.runner_busy',
    `Every Code runner slot stayed busy for ${String(CODE_LIMITS.slotWaitSeconds / 60)} minutes, so this step stopped waiting.`,
  );
const unavailable = () =>
  failed(
    'code.runner_unavailable',
    'The Code runner stopped or couldn’t be reached before it returned a result.',
  );

/** Only this worker adapter knows the transport; executors receive a scoped capability. */
export function createCodeRunnerClient(config: WorkerCodeRunnerConfig) {
  const closing = new AbortController();
  const connections = new Set<Socket>();
  return {
    close: () => {
      closing.abort();
      for (const socket of connections) socket.destroy();
    },
    execute: async (
      task: CodeTask,
      caller: AbortSignal,
    ): Promise<CodeResult> => {
      if (!config.settings.enabled)
        return failed(
          'code.disabled',
          'Code steps are disabled by the administrator.',
        );
      if (task.timeoutSeconds > config.settings.maximumSeconds)
        return failed(
          'code.disabled',
          'Lower this step’s time limit to the administrator’s maximum before running.',
        );
      const signal = AbortSignal.any([caller, closing.signal]);
      // Waiting for a slot doesn't count against the step's own time limit,
      // which starts only once the runner takes the task.
      const waitDeadline = Date.now() + CODE_LIMITS.slotWaitSeconds * 1_000;
      for (;;) {
        signal.throwIfAborted();
        const socket = connect(config.socketPath);
        connections.add(socket);
        try {
          const answer = await exchangeTask(config, socket, task, {
            signal,
            waitDeadline,
          });
          if (answer !== 'full') return answer;
        } finally {
          socket.destroy();
          connections.delete(socket);
        }
        if (Date.now() >= waitDeadline) return stayedBusy();
        await delay(RUNNER_CONNECTION.busyRetryDelayMillis, undefined, {
          signal,
        });
      }
    },
  };
}

/** One connection: the greeting, a turn in the runner's queue, then the task. */
async function exchangeTask(
  config: WorkerCodeRunnerConfig,
  socket: Socket,
  task: CodeTask,
  {
    signal,
    waitDeadline,
  }: Readonly<{ signal: AbortSignal; waitDeadline: number }>,
): Promise<CodeResult | 'full'> {
  const disconnected = new AbortController();
  socket.on('error', () => {
    disconnected.abort();
  });
  socket.once('close', () => {
    disconnected.abort();
  });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  // Aborted only when the slot wait runs out while the runner holds the task.
  const slotWait = new AbortController();
  const slotWaitTimer = setTimeout(
    () => {
      slotWait.abort();
    },
    Math.max(0, waitDeadline - Date.now()),
  );
  const read = (bytes: number, limit: AbortSignal) =>
    readCodeFrame(
      socket,
      bytes,
      AbortSignal.any([signal, disconnected.signal, limit]),
    );
  try {
    const greeting = codeGreetingSchema.parse(
      await read(
        RUNNER_CONNECTION.greetingBytes,
        AbortSignal.timeout(RUNNER_CONNECTION.greetingTimeoutMillis),
      ),
    );
    const refusal = refuseRunner(config, greeting);
    if (refusal !== undefined) return refusal;
    if (greeting.kind === 'busy') return 'full';
    if (greeting.kind === 'queued') {
      const turn = codeGreetingSchema.parse(
        await read(RUNNER_CONNECTION.greetingBytes, slotWait.signal),
      );
      if (turn.kind !== 'ready')
        return failed(
          'code.runner_unavailable',
          'The Code runner answered out of order.',
        );
    }
    clearTimeout(slotWaitTimer);
    if (Buffer.byteLength(JSON.stringify(task)) > CODE_LIMITS.taskBytes)
      return failed(
        'code.runner_unavailable',
        'Code task exceeds the bounded transport envelope.',
      );
    await writeCodeFrame(socket, task);
    return codeResultSchema.parse(
      await read(
        CODE_LIMITS.resultBytes,
        AbortSignal.timeout(
          (task.timeoutSeconds + RUNNER_CONNECTION.resultGraceSeconds) * 1_000,
        ),
      ),
    );
  } catch {
    signal.throwIfAborted();
    return slotWait.signal.aborted && !disconnected.signal.aborted
      ? stayedBusy()
      : unavailable();
  } finally {
    clearTimeout(slotWaitTimer);
    signal.removeEventListener('abort', abort);
  }
}

/** A runner this worker must not send private input to, or one that can't take the task. */
function refuseRunner(
  config: WorkerCodeRunnerConfig,
  greeting: CodeGreeting,
): CodeResult | undefined {
  if (config.requireHardened && greeting.mode !== 'hardened')
    return failed(
      'code.runner_unavailable',
      'A deployed worker requires the hardened Code runner.',
    );
  if (!greeting.settings.enabled)
    return failed(
      'code.disabled',
      'Code steps are disabled by the administrator.',
    );
  const runnerSettingsMismatch =
    greeting.settings.memoryMiB !== config.settings.memoryMiB ||
    greeting.settings.maximumSeconds !== config.settings.maximumSeconds ||
    greeting.settings.concurrency !== config.settings.concurrency ||
    JSON.stringify(greeting.settings.extraPackages) !==
      JSON.stringify(config.settings.extraPackages) ||
    JSON.stringify(greeting.settings.pythonPackages) !==
      JSON.stringify(config.settings.pythonPackages);
  if (runnerSettingsMismatch)
    return failed(
      'code.runner_unavailable',
      'The worker and Code runner settings do not match.',
    );
  return undefined;
}
