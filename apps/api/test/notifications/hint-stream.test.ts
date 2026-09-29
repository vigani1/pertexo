import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { writeInboxHintStream } from '../../src/notifications/hint-stream.js';
import type {
  InboxHintSignal,
  InboxHintSubscription,
} from '../../src/notifications/inbox-hint-hub.js';

class FakeDestination extends EventEmitter {
  public destroyed = false;
  public writableNeedDrain = false;
  public ended = false;
  public readonly chunks: string[] = [];

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.writableNeedDrain;
  }

  public end(): void {
    this.ended = true;
  }
}

/** A subscription whose signals the test pushes one at a time. */
function subscription() {
  const pending: InboxHintSignal[] = [];
  let waiter: ((result: IteratorResult<InboxHintSignal>) => void) | undefined;
  let closed = false;
  const close = vi.fn(() => {
    closed = true;
    waiter?.({ done: true, value: undefined });
    waiter = undefined;
  });
  const source: InboxHintSubscription = {
    close,
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = pending.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
    }),
  };
  return {
    source,
    close,
    push: (signal: InboxHintSignal) => {
      if (waiter === undefined) pending.push(signal);
      else {
        const resolve = waiter;
        waiter = undefined;
        resolve({ done: false, value: signal });
      }
    },
  };
}

function authorization() {
  return {
    authorizationLost: new AbortController().signal,
    reauthorize: vi.fn(() => Promise.resolve()),
  };
}

const events = (destination: FakeDestination) =>
  destination.chunks.filter((chunk) => !chunk.startsWith(':'));

describe('inbox hint stream', () => {
  it('announces readiness, forwards content-free hints and ends on close', async () => {
    const hints = subscription();
    const destination = new FakeDestination();
    const controller = new AbortController();
    const access = authorization();
    const streaming = writeInboxHintStream(
      hints.source,
      destination,
      access,
      controller.signal,
    );
    hints.push({ kind: 'changed', revision: '12' });
    hints.push({ kind: 'resync' });
    await vi.waitFor(() => {
      expect(events(destination)).toHaveLength(3);
    });
    controller.abort();
    await streaming;
    expect(events(destination)).toEqual([
      'event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n',
      'event: inbox.changed\ndata: {"schemaVersion":1,"revision":"12"}\n\n',
      'event: inbox.changed\ndata: {"schemaVersion":1,"revision":null}\n\n',
    ]);
    expect(access.reauthorize).toHaveBeenCalledTimes(2);
    expect(hints.close).toHaveBeenCalled();
    expect(destination.ended).toBe(true);
  });

  it('stops without writing a hint once the reader loses access', async () => {
    const hints = subscription();
    const destination = new FakeDestination();
    const lost = new AbortController();
    const failure = new Error('membership revoked');
    const streaming = writeInboxHintStream(
      hints.source,
      destination,
      {
        authorizationLost: lost.signal,
        reauthorize: () => Promise.reject(failure),
      },
      new AbortController().signal,
    );
    hints.push({ kind: 'changed', revision: '3' });
    await expect(streaming).rejects.toBe(failure);
    expect(events(destination)).toHaveLength(1);

    const revoked = subscription();
    const revokedDestination = new FakeDestination();
    const revocation = new Error('session expired');
    lost.abort(revocation);
    await expect(
      writeInboxHintStream(
        revoked.source,
        revokedDestination,
        { authorizationLost: lost.signal, reauthorize: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toBe(revocation);
    expect(revoked.close).toHaveBeenCalled();
  });

  it('waits for a slow client to drain, then sends the newest hint', async () => {
    const hints = subscription();
    const destination = new FakeDestination();
    const controller = new AbortController();
    const streaming = writeInboxHintStream(
      hints.source,
      destination,
      authorization(),
      controller.signal,
    );
    destination.writableNeedDrain = true;
    hints.push({ kind: 'changed', revision: '4' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events(destination)).toHaveLength(1);
    destination.writableNeedDrain = false;
    destination.emit('drain');
    await vi.waitFor(() => {
      expect(events(destination)).toHaveLength(2);
    });
    controller.abort();
    await streaming;
  });

  it('keeps an idle connection alive with comments only while it can write', async () => {
    vi.useFakeTimers();
    try {
      const hints = subscription();
      const destination = new FakeDestination();
      const controller = new AbortController();
      const streaming = writeInboxHintStream(
        hints.source,
        destination,
        authorization(),
        controller.signal,
        1_000,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      destination.writableNeedDrain = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        destination.chunks.filter((chunk) => chunk === ': keepalive\n\n'),
      ).toHaveLength(1);
      controller.abort();
      await streaming;
    } finally {
      vi.useRealTimers();
    }
  });
});
