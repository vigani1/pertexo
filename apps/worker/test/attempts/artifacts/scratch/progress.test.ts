import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { withByteProgress } from '../../../../src/attempts/artifacts/scratch/progress.js';
afterEach(() => {
  vi.useRealTimers();
});
it('destroys a stalled storage source after sixty seconds without byte progress', async () => {
  vi.useFakeTimers();
  const source = new Readable({ read: () => undefined });
  const iterator = withByteProgress(source, new AbortController().signal)[
    Symbol.asyncIterator
  ]();
  const pending = iterator.next();
  const refused = expect(pending).rejects.toMatchObject({
    safeErrorCode: 'execution.file_progress_timeout',
  });
  await vi.advanceTimersByTimeAsync(60000);
  await refused;
  expect(source.destroyed).toBe(true);
});
it('cancels a pending source read without waiting for its progress timer', async () => {
  const controller = new AbortController();
  const source = new Readable({ read: () => undefined });
  const iterator = withByteProgress(source, controller.signal)[
    Symbol.asyncIterator
  ]();
  const pending = iterator.next();
  const refused = expect(pending).rejects.toMatchObject({ kind: 'canceled' });
  controller.abort();
  await refused;
  expect(source.destroyed).toBe(true);
});
it('closes a paused source when its consumer returns', async () => {
  const source = Readable.from([Buffer.from('first'), Buffer.from('second')]);
  const iterator = withByteProgress(source, new AbortController().signal)[
    Symbol.asyncIterator
  ]();
  expect((await iterator.next()).done).toBe(false);
  await iterator.return?.();
  expect(source.destroyed).toBe(true);
});

it('uses the existing execution deadline before the no-progress window', async () => {
  vi.useFakeTimers();
  const source = new Readable({ read: () => undefined });
  const stream = withByteProgress(
    source,
    new AbortController().signal,
    new Date(Date.now() + 1500),
  );
  const refused = expect(
    stream[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ safeErrorCode: 'execution.file_deadline' });
  await vi.advanceTimersByTimeAsync(1500);
  await refused;
  expect(source.destroyed).toBe(true);
});
it('emits timeout even while its downstream is paused by backpressure', async () => {
  vi.useFakeTimers();
  const source = new Readable({ read: () => undefined });
  const stream = withByteProgress(source, new AbortController().signal);
  source.push(Buffer.alloc(65536));
  const error = new Promise<unknown>((resolve) =>
    stream.once('error', resolve),
  );
  await vi.advanceTimersByTimeAsync(60000);
  expect(await error).toMatchObject({
    safeErrorCode: 'execution.file_progress_timeout',
  });
  expect(source.destroyed).toBe(true);
});
