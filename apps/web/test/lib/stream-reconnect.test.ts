import { expect, it } from 'vitest';
import {
  classifyStreamFailure,
  streamWasHealthy,
} from '@/lib/api/stream-reconnect';
import { TransientStreamDisconnect } from '@/lib/api/stream-reconnect.errors';

it('resets quiet-stream failures only after the healthy threshold', () => {
  const stream = { delivered: false, openedAt: 100_000 };
  expect(streamWasHealthy(stream, () => 129_999)).toBe(false);
  expect(streamWasHealthy(stream, () => 130_000)).toBe(true);
  expect(streamWasHealthy(stream, () => 130_001)).toBe(true);
});
it('reconnects a normal early close but stops an unreadable stream', () => {
  expect(
    classifyStreamFailure(new TransientStreamDisconnect(), 1),
  ).toMatchObject({ kind: 'retry', reason: 'disconnected' });
  expect(classifyStreamFailure(new Error('bad stream'), 1)).toEqual({
    kind: 'stop',
    reason: 'unreadable',
  });
});
