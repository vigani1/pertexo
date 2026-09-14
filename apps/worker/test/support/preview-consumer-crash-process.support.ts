import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterAll } from 'vitest';

export interface PreviewCrashChild {
  readonly evidence: Promise<Record<string, unknown>>;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  next(
    predicate?: (value: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  kill(): Promise<NodeJS.Signals | null>;
}

const activeCrashChildren = new Set<PreviewCrashChild>();
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_QUEUED_MESSAGES = 100;
const MAX_WAITERS = 100;

interface EvidenceWaiter {
  predicate: (value: Record<string, unknown>) => boolean;
  settle: (
    outcome:
      | { kind: 'resolve'; value: Record<string, unknown> }
      | { kind: 'reject'; error: unknown },
  ) => void;
}

function boundedAppend(
  current: string,
  chunk: string,
  maximum: number,
): string {
  const next = current + chunk;
  if (Buffer.byteLength(next) > maximum)
    throw new Error('preview crash child output exceeded its bounded limit');
  return next;
}

function evidenceRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('preview crash child emitted invalid evidence');
  return parsed as Record<string, unknown>;
}

export function managePreviewCrashChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  options: {
    readonly evidenceTimeoutMillis?: number;
    readonly killTimeoutMillis?: number;
  } = {},
): PreviewCrashChild {
  const evidenceTimeoutMillis = options.evidenceTimeoutMillis ?? 15_000;
  const killTimeoutMillis = options.killTimeoutMillis ?? 5_000;
  let stderr = '';
  let buffer = '';
  let terminalError: unknown;
  let exitResult:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<EvidenceWaiter>();

  const rejectWaiters = (error: unknown): void => {
    terminalError ??= error;
    for (const waiter of [...waiters])
      waiter.settle({ kind: 'reject', error: terminalError });
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    try {
      stderr = boundedAppend(stderr, chunk, MAX_STDERR_BYTES);
    } catch (error) {
      rejectWaiters(error);
      child.kill('SIGKILL');
    }
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let settled = false;
    const settleExit = (
      result: { code: number | null; signal: NodeJS.Signals | null },
      error?: unknown,
    ): void => {
      if (settled) return;
      settled = true;
      exitResult = result;
      rejectWaiters(
        error ??
          new Error(
            `preview crash child exited before evidence: code=${String(result.code)} signal=${String(result.signal)} stderr=${stderr}`,
          ),
      );
      resolve(result);
    };
    child.once('error', (error) => {
      settleExit({ code: null, signal: null }, error);
    });
    child.once('exit', (code, signal) => {
      settleExit({ code, signal });
    });
  });

  const deliver = (message: Record<string, unknown>): void => {
    for (const waiter of waiters) {
      let matches: boolean;
      try {
        matches = waiter.predicate(message);
      } catch (error) {
        waiter.settle({ kind: 'reject', error });
        continue;
      }
      if (matches) {
        waiter.settle({ kind: 'resolve', value: message });
        return;
      }
    }
    if (messages.length >= MAX_QUEUED_MESSAGES) {
      rejectWaiters(new Error('preview crash child queued too much evidence'));
      child.kill('SIGKILL');
      return;
    }
    messages.push(message);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      buffer = boundedAppend(buffer, chunk, MAX_BUFFER_BYTES);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines)
        if (line.trim() !== '') deliver(evidenceRecord(line));
    } catch (error) {
      rejectWaiters(error);
      child.kill('SIGKILL');
    }
  });

  const next = (
    predicate: (value: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined) continue;
      let matches: boolean;
      try {
        matches = predicate(message);
      } catch (error) {
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error('Preview crash evidence predicate failed', {
                cause: error,
              }),
        );
      }
      if (matches) return Promise.resolve(messages.splice(index, 1)[0] ?? {});
    }
    if (terminalError !== undefined)
      return Promise.reject(
        terminalError instanceof Error
          ? terminalError
          : new Error('Preview crash child failed', { cause: terminalError }),
      );
    if (waiters.size >= MAX_WAITERS)
      return Promise.reject(
        new Error('preview crash child has too many waiters'),
      );
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const waiter: EvidenceWaiter = {
        predicate,
        settle(outcome) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(waiter);
          if (outcome.kind === 'resolve') resolve(outcome.value);
          else
            reject(
              outcome.error instanceof Error
                ? outcome.error
                : new Error('Preview crash evidence wait failed', {
                    cause: outcome.error,
                  }),
            );
        },
      };
      const timer = setTimeout(() => {
        waiter.settle({
          kind: 'reject',
          error: new Error(`preview crash child evidence timeout: ${stderr}`),
        });
      }, evidenceTimeoutMillis);
      waiters.add(waiter);
    });
  };

  let killPromise: Promise<NodeJS.Signals | null> | undefined;
  const evidence = next();
  void evidence.catch(() => undefined);
  const selected: PreviewCrashChild = {
    evidence,
    exited,
    next,
    kill: () => {
      killPromise ??= (async () => {
        if (exitResult === undefined && !child.kill('SIGKILL'))
          throw new Error('preview crash child could not be signaled');
        const timeout = Promise.withResolvers<never>();
        const timer = setTimeout(() => {
          timeout.reject(
            new Error('preview crash child did not exit after kill'),
          );
        }, killTimeoutMillis);
        timer.unref();
        try {
          return (await Promise.race([exited, timeout.promise])).signal;
        } finally {
          clearTimeout(timer);
        }
      })();
      return killPromise;
    },
  };
  return selected;
}

export function spawnPreviewCrashChild(
  input: Record<string, unknown>,
): PreviewCrashChild {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL(
          '../preview-reconciliation-process-fixture.mjs',
          import.meta.url,
        ),
      ),
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: {
        ...process.env,
        PREVIEW_RECONCILIATION_CHILD_INPUT: JSON.stringify(input),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const selected = managePreviewCrashChild(child);
  activeCrashChildren.add(selected);
  void selected.exited.then(() => {
    activeCrashChildren.delete(selected);
  });
  return selected;
}

afterAll(async () => {
  const results = await Promise.allSettled(
    [...activeCrashChildren].map(async (child) => child.kill()),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Preview crash child cleanup failed');
});
