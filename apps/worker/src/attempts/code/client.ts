import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CODE_LIMITS,
  codeGreetingSchema,
  codeResultSchema,
  type CodeResult,
  type CodeTask,
  type CodeSettings,
} from '@pertexo/node-sdk';
import { readCodeFrame, writeCodeFrame } from '@pertexo/node-sdk/server';

export type WorkerCodeRunnerConfig = Readonly<{
  settings: CodeSettings;
  socketPath: string;
  requireHardened: boolean;
}>;
const failed = (
  code: 'code.disabled' | 'code.runner_unavailable',
  message: string,
): CodeResult => ({
  kind: 'failed',
  code,
  diagnostics: { logs: [], truncated: false, error: { message } },
});

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
      const waitDeadline = Date.now() + 5000;
      for (;;) {
        signal.throwIfAborted();
        const socket = connect(config.socketPath);
        connections.add(socket);
        const disconnected = new AbortController();
        socket.on('error', () => {
          disconnected.abort();
        });
        socket.once('close', () => {
          disconnected.abort();
          connections.delete(socket);
        });
        const abort = () => socket.destroy();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const greeting = codeGreetingSchema.parse(
            await readCodeFrame(
              socket,
              16 * 1024,
              AbortSignal.any([
                signal,
                disconnected.signal,
                AbortSignal.timeout(2000),
              ]),
            ),
          );
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
            greeting.settings.maximumSeconds !==
              config.settings.maximumSeconds ||
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
          if (greeting.kind === 'busy') {
            if (Date.now() >= waitDeadline)
              return failed(
                'code.runner_unavailable',
                'Code runner slots are busy. This safe attempt can retry.',
              );
          } else {
            if (task.timeoutSeconds > greeting.settings.maximumSeconds)
              return failed(
                'code.runner_unavailable',
                'Code step timeout exceeds the runner maximum.',
              );
            const body = JSON.stringify(task);
            if (Buffer.byteLength(body) > CODE_LIMITS.taskBytes)
              return failed(
                'code.runner_unavailable',
                'Code task exceeds the bounded transport envelope.',
              );
            await writeCodeFrame(socket, task);
            return codeResultSchema.parse(
              await readCodeFrame(
                socket,
                CODE_LIMITS.resultBytes,
                AbortSignal.any([
                  signal,
                  disconnected.signal,
                  AbortSignal.timeout((task.timeoutSeconds + 2) * 1000),
                ]),
              ),
            );
          }
        } catch {
          signal.throwIfAborted();
          return failed(
            'code.runner_unavailable',
            'Code runner is unavailable. This safe attempt can retry.',
          );
        } finally {
          signal.removeEventListener('abort', abort);
          socket.destroy();
          connections.delete(socket);
        }
        await delay(50, undefined, { signal });
      }
    },
  };
}
