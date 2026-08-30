import { spawn } from 'node:child_process';

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

export function spawnPreviewCrashChild(
  input: Record<string, unknown>,
): PreviewCrashChild {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      new URL('../preview-reconciliation-process-fixture.mjs', import.meta.url)
        .pathname,
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        ...process.env,
        PREVIEW_RECONCILIATION_CHILD_INPUT: JSON.stringify(input),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: (value: Record<string, unknown>) => void;
  }[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiterIndex = waiters.findIndex(({ predicate }) =>
        predicate(message),
      );
      if (waiterIndex === -1) messages.push(message);
      else waiters.splice(waiterIndex, 1)[0]?.resolve(message);
    }
  });
  const next = async (
    predicate: (value: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> => {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex !== -1) return messages.splice(existingIndex, 1)[0] ?? {};
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        waiters.push({ predicate, resolve });
      }),
      exited.then(({ code, signal }) => {
        throw new Error(
          `preview crash child exited before evidence: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        );
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`preview crash child evidence timeout: ${stderr}`));
        }, 15_000);
      }),
    ]);
  };
  const selected: PreviewCrashChild = {
    evidence: next(),
    exited,
    next,
    kill: async (): Promise<NodeJS.Signals | null> => {
      child.kill('SIGKILL');
      return (await exited).signal;
    },
  };
  activeCrashChildren.add(selected);
  void exited.then(() => activeCrashChildren.delete(selected));
  return selected;
}

afterAll(async () => {
  await Promise.allSettled(
    [...activeCrashChildren].map(async (child) => child.kill()),
  );
});
