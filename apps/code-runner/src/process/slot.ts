import { retainCodeText } from './diagnostics.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import {
  CODE_LIMITS,
  NODE_JSON_LIMITS,
  codeResultSchema,
  codeContainerLimits,
  CODE_PYTHON_MODULES,
  type CodeLanguage,
  type CodeTask,
  type CodeResult,
  type CodeErrorCode,
} from '@pertexo/node-sdk';
import type { RunnerConfig } from '../config.js';
import type { ModulePolicy } from '../execution/modules.js';
import type { ChildBoot } from './boot.js';
import {
  readCodeFrame as readFrame,
  writeCodeFrame as writeFrame,
} from '@pertexo/node-sdk/server';
import { captureTaskLogs } from './logs.js';

export type TaskSlot = Readonly<{
  run(task: CodeTask, signal: AbortSignal): Promise<CodeResult>;
  stop(): Promise<void>;
  readonly exited: Promise<void>;
}>;
export async function startTaskSlot(
  config: RunnerConfig,
  policy: ModulePolicy,
  {
    ordinal,
    lifetime,
    language = 'javascript',
  }: Readonly<{
    ordinal: number;
    lifetime: AbortSignal;
    language?: CodeLanguage | undefined;
  }>,
): Promise<TaskSlot> {
  const child = spawnTaskChild(config, policy, { ordinal, language });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifetime]);
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => {
      controller.abort();
      resolve();
    }),
  );
  child.on('error', () => {
    controller.abort();
  });
  const input = child.stdin,
    control = child.stdio[3] as Readable | null;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopPromise ??= (async () => {
      controller.abort();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      input?.destroy();
      control?.destroy();
      await exited;
    })());
  const onAbort = () => {
    void stop();
  };
  lifetime.addEventListener('abort', onAbort, { once: true });
  void exited.then(() => {
    lifetime.removeEventListener('abort', onAbort);
  });
  let failure: CodeErrorCode | undefined;
  const fail = (code: CodeErrorCode) => {
    failure ??= code;
    void stop();
  };
  const logs = captureTaskLogs(() => {
    fail('code.output_invalid');
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    logs.append(chunk);
  });
  let stderr = '',
    stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > CODE_LIMITS.logBytes) {
      fail('code.output_invalid');
      return;
    }
    if (stderr.length < 8192)
      stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
  });
  if (input === null || control === null) {
    await stop();
    throw new Error('Code task process has no private protocol descriptor');
  }
  control.on('error', () => {
    controller.abort();
  });
  input.on('error', () => {
    controller.abort();
  });
  const startup = AbortSignal.timeout(10_000);
  try {
    const greeting = await readFrame(
      control,
      1024,
      AbortSignal.any([signal, startup]),
    );
    const invalidChildGreeting =
      typeof greeting !== 'object' ||
      greeting === null ||
      !('kind' in greeting) ||
      greeting.kind !== 'ready';
    if (invalidChildGreeting)
      throw new Error('Code task process failed to start');
    if (signal.aborted)
      throw new Error('Code task process exited during startup');
  } catch (error: unknown) {
    await stop();
    throw new Error(
      'Code task process could not initialize its module policy',
      { cause: new Error(stderr || String(error)) },
    );
  }
  return Object.freeze({
    stop,
    exited,
    run: createTaskExecution({
      config,
      process: { child, input, control },
      lifecycle: { signal, lifetime, stop },
      diagnostics: { logs, fail, failure: () => failure, stderr: () => stderr },
    }),
  });
}

function codeTerminationMessage(code: CodeErrorCode): string {
  if (code === 'code.timeout') return 'Code reached its time limit.';
  if (code === 'code.memory_limit') return 'Code reached its memory limit.';
  if (code === 'code.output_invalid')
    return 'Code exceeded its bounded output or diagnostic stream. Return and log less data.';
  return 'Code process ended without a valid JSON result.';
}

function spawnTaskChild(
  config: RunnerConfig,
  policy: ModulePolicy,
  { ordinal, language }: Readonly<{ ordinal: number; language: CodeLanguage }>,
): ChildProcess {
  const boot: ChildBoot = {
    json: NODE_JSON_LIMITS,
    console: {
      bytes: CODE_LIMITS.logBytes,
      lines: CODE_LIMITS.logLines,
      characters: CODE_LIMITS.logLineCharacters,
    },
    modules: policy,
    taskBytes: CODE_LIMITS.taskBytes,
    pythonModules: CODE_PYTHON_MODULES,
    pythonPackages: config.settings.pythonPackages,
  };
  const entry = fileURLToPath(new URL('./child.js', import.meta.url));
  const reads = [
    fileURLToPath(new URL('../', import.meta.url)),
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    ...policy.readPaths,
  ];
  const args =
    language === 'python'
      ? [
          '-I',
          '-B',
          '-u',
          // CPython's script entry uses FIOCLEX, outside the existing filter.
          // run_path reads trusted code without weakening the syscall policy.
          '-c',
          `import runpy; runpy.run_path(${JSON.stringify(fileURLToPath(new URL('../../python/task.py', import.meta.url)))})`,
        ]
      : [
          '--permission',
          '--disable-wasm-trap-handler',
          '--no-experimental-strip-types',
          `--max-old-space-size=${String(config.settings.memoryMiB)}`,
          '--v8-pool-size=1',
          ...reads.map((path) => '--allow-fs-read=' + path),
          entry,
        ];
  const executable = language === 'python' ? 'python3.15' : process.execPath;
  const child: ChildProcess =
    config.mode === 'hardened'
      ? spawn(
          fileURLToPath(new URL('../launch', import.meta.url)),
          [
            String(20000 + ordinal),
            String(config.settings.memoryMiB),
            String(config.settings.maximumSeconds),
            language === 'python'
              ? '/opt/pertexo-python/bin/python3.15'
              : executable,
            ...args,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            env: {
              PATH: '/usr/local/bin:/usr/bin:/bin',
              UV_THREADPOOL_SIZE: '1',
              CODE_CHILD_BOOT: JSON.stringify(boot),
            },
          },
        )
      : spawn(executable, args, {
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            UV_THREADPOOL_SIZE: '1',
            CODE_CHILD_BOOT: JSON.stringify(boot),
          },
        });

  return child;
}

function createTaskExecution({
  config,
  process: processIo,
  lifecycle,
  diagnostics,
}: Readonly<{
  config: RunnerConfig;
  process: Readonly<{
    child: ChildProcess;
    input: Writable;
    control: Readable;
  }>;
  lifecycle: Readonly<{
    signal: AbortSignal;
    lifetime: AbortSignal;
    stop(): Promise<void>;
  }>;
  diagnostics: Readonly<{
    logs: ReturnType<typeof captureTaskLogs>;
    fail(code: CodeErrorCode): void;
    failure(): CodeErrorCode | undefined;
    stderr(): string;
  }>;
}>): TaskSlot['run'] {
  const { child, input, control } = processIo;
  const { signal, lifetime, stop } = lifecycle;
  const { logs, fail } = diagnostics;
  let used = false;
  return async (task: CodeTask, canceled: AbortSignal): Promise<CodeResult> => {
    if (used) throw new Error('Code task processes are single-use');
    used = true;
    const timeout = setTimeout(() => {
      fail('code.timeout');
    }, task.timeoutSeconds * 1000);
    const cancel = () => {
      void stop();
    };
    canceled.addEventListener('abort', cancel, { once: true });
    let checking = false;
    const memory =
      config.mode === 'hardened'
        ? setInterval(() => {
            const childUnavailableForMemoryCheck =
              checking ||
              child.pid === undefined ||
              child.exitCode !== null ||
              child.signalCode !== null;
            if (childUnavailableForMemoryCheck) return;
            checking = true;
            void readFile(`/proc/${String(child.pid)}/status`, 'utf8')
              .then((status) => {
                const rss = Number(
                  /^VmRSS:\s*(\d+) kB$/mu.exec(status)?.[1] ?? '0',
                );
                if (
                  rss >
                    codeContainerLimits(config.settings).taskRssMiB * 1024 &&
                  child.exitCode === null &&
                  child.signalCode === null
                )
                  fail('code.memory_limit');
              })
              .catch(() => undefined)
              .finally(() => {
                checking = false;
              });
          }, 50)
        : undefined;
    let result: CodeResult;
    try {
      canceled.throwIfAborted();
      signal.throwIfAborted();
      await writeFrame(input, task);
      result = codeResultSchema.parse(
        await readFrame(control, CODE_LIMITS.resultBytes, signal),
      );
    } catch {
      if (canceled.aborted || lifetime.aborted) {
        await stop();
        throw new Error('Code task canceled', {
          cause: canceled.reason ?? lifetime.reason,
        });
      }
      const code =
        diagnostics.failure() ??
        (/heap out of memory|allocation failed|out of memory|MemoryError/iu.test(
          diagnostics.stderr(),
        ) || child.signalCode === 'SIGABRT'
          ? 'code.memory_limit'
          : 'code.runtime_error');
      result = {
        kind: 'failed',
        code,
        diagnostics: {
          logs: [],
          truncated: false,
          error: {
            message: codeTerminationMessage(code),
          },
        },
      };
    } finally {
      clearTimeout(timeout);
      if (memory !== undefined) clearInterval(memory);
      canceled.removeEventListener('abort', cancel);
      await stop();
    }
    const console = logs.snapshot();
    const error = result.diagnostics.error;
    const retainedError =
      error === undefined
        ? undefined
        : retainCodeText(error.message, CODE_LIMITS.messageCharacters);
    return {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        logs: console.logs,
        truncated: console.truncated || (retainedError?.truncated ?? false),
        ...(error === undefined || retainedError === undefined
          ? {}
          : { error: { ...error, message: retainedError.message } }),
      },
    };
  };
}
