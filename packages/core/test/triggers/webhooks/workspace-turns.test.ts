import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { WebhookIntakeBusyError } from '../../../src/triggers/webhooks/errors.js';
import { createWorkspaceTurns } from '../../../src/triggers/webhooks/runtime/workspace-turns.js';

function gate() {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('turns at one workspace', () => {
  it('runs no more than the allowed number at once, the rest in arrival order', async () => {
    const turns = createWorkspaceTurns({ atOnce: 2, maxWaitMillis: 5_000 });
    const started: number[] = [];
    const finish = Array.from({ length: 5 }, gate);
    const all = finish.map(({ opened }, at) =>
      turns.take('workspace', undefined, async () => {
        started.push(at);
        await opened;
      }),
    );
    await delay(0);
    expect(started).toEqual([0, 1]);
    finish[1]?.open();
    await delay(0);
    expect(started).toEqual([0, 1, 2]);
    finish[0]?.open();
    finish[2]?.open();
    await delay(0);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    finish[3]?.open();
    finish[4]?.open();
    await Promise.all(all);
  });

  it('lets another workspace go while one is full', async () => {
    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 5_000 });
    const held = gate();
    const full = turns.take('full', undefined, () => held.opened);
    await expect(
      turns.take('other', undefined, () => Promise.resolve('served')),
    ).resolves.toBe('served');
    held.open();
    await full;
  });

  it('refuses work that waited too long, without running it', async () => {
    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 20 });
    const held = gate();
    const first = turns.take('workspace', undefined, () => held.opened);
    let ran = false;
    await expect(
      turns.take('workspace', undefined, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(WebhookIntakeBusyError);
    held.open();
    await first;
    await delay(0);
    expect(ran).toBe(false);
  });

  it('never runs the work of a sender who left, and answers with the reason given', async () => {
    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 5_000 });
    const held = gate();
    const first = turns.take('workspace', undefined, () => held.opened);
    const sender = new AbortController();
    const left = new Error('sender left');
    let ran = false;
    const waiting = turns.take('workspace', sender.signal, () => {
      ran = true;
      return Promise.resolve();
    });
    sender.abort(left);
    await expect(waiting).rejects.toBe(left);
    held.open();
    await first;
    await delay(0);
    expect(ran).toBe(false);
  });

  it('passes the turn on when work fails, so a failure costs only itself', async () => {
    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 5_000 });
    const failure = new Error('rolled back');
    const failing = turns.take('workspace', undefined, () =>
      Promise.reject(failure),
    );
    const next = turns.take('workspace', undefined, () =>
      Promise.resolve('accepted'),
    );
    await expect(failing).rejects.toBe(failure);
    await expect(next).resolves.toBe('accepted');
  });

  it('skips a waiter that gave up and serves the one behind it', async () => {
    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 5_000 });
    const held = gate();
    const first = turns.take('workspace', undefined, () => held.opened);
    const sender = new AbortController();
    const gaveUp = turns.take('workspace', sender.signal, () =>
      Promise.resolve('never'),
    );
    const behind = turns.take('workspace', undefined, () =>
      Promise.resolve('served'),
    );
    sender.abort(new Error('sender left'));
    await expect(gaveUp).rejects.toThrow('sender left');
    held.open();
    await first;
    await expect(behind).resolves.toBe('served');
  });
});
