import {
  ChildProcess,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { managePreviewCrashChild } from './support/preview-consumer-crash-process.support.js';

function managedChild(script: string) {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return managePreviewCrashChild(child, {
    killTimeoutMillis: 500,
  });
}

function controlledChild(): ChildProcessByStdio<
  null,
  PassThrough,
  PassThrough
> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), {
    stdin: null,
    stdout,
    stderr,
    stdio: [null, stdout, stderr, null, null] as const,
  });
  let killed = false;

  child.kill = (signal: NodeJS.Signals = 'SIGKILL') => {
    if (killed) return false;
    killed = true;
    stdout.destroy();
    stderr.destroy();
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

describe('preview crash child evidence ownership', () => {
  it('delivers split and queued newline-framed evidence exactly once', async () => {
    const child = managedChild(`
process.stdout.write('{"stage":"fir');
setTimeout(() => {
  process.stdout.write('st"}\\n{"stage":"second"}\\n');
}, 5);
setInterval(() => {}, 1000);
`);
    try {
      await expect(child.evidence).resolves.toEqual({ stage: 'first' });
      await expect(
        child.next((value) => value.stage === 'second'),
      ).resolves.toEqual({ stage: 'second' });
    } finally {
      await child.kill();
    }
  });

  it('removes a timed-out waiter so later evidence reaches a new waiter', async () => {
    vi.useFakeTimers();
    const rawChild = controlledChild();
    const child = managePreviewCrashChild(rawChild, {
      evidenceTimeoutMillis: 50,
      killTimeoutMillis: 500,
    });
    try {
      const timedOut = expect(child.evidence).rejects.toThrow(
        /evidence timeout/u,
      );
      await vi.advanceTimersByTimeAsync(50);
      await timedOut;
      expect(vi.getTimerCount()).toBe(0);
      const late = child.next((value) => value.stage === 'late');
      rawChild.stdout.write('{"stage":"late"}\n');
      await expect(late).resolves.toEqual({ stage: 'late' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try {
        await child.kill();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('contains malformed output and throwing predicates without stale waiters', async () => {
    const malformed = managedChild(
      `process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);`,
    );
    await expect(malformed.evidence).rejects.toBeInstanceOf(Error);
    await malformed.exited;

    const throwing = managedChild(`
process.stdout.write('{"stage":"first"}\\n');
setTimeout(() => process.stdout.write('{"stage":"second"}\\n'), 10);
setInterval(() => {}, 1000);
`);
    try {
      await throwing.evidence;
      await expect(
        throwing.next(() => {
          throw new Error('predicate failed');
        }),
      ).rejects.toThrow('predicate failed');
      await expect(throwing.next()).resolves.toEqual({ stage: 'second' });
    } finally {
      const firstKill = throwing.kill();
      const secondKill = throwing.kill();
      expect(secondKill).toBe(firstKill);
      await firstKill;
    }
  });
});
