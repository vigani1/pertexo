import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { managePreviewCrashChild } from './support/preview-consumer-crash-process.support.js';

function managedChild(script: string, evidenceTimeoutMillis = 100) {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return managePreviewCrashChild(child, {
    evidenceTimeoutMillis,
    killTimeoutMillis: 500,
  });
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
    const child = managedChild(
      `setTimeout(() => process.stdout.write('{"stage":"late"}\\n'), 60); setInterval(() => {}, 1000);`,
      50,
    );
    try {
      await expect(child.evidence).rejects.toThrow(/evidence timeout/u);
      await expect(
        child.next((value) => value.stage === 'late'),
      ).resolves.toEqual({ stage: 'late' });
    } finally {
      await child.kill();
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
