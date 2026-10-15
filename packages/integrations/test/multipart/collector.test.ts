import FormData from 'form-data';
import { describe, expect, it } from 'vitest';
import { collectMultipart } from '../../src/http-request/multipart/collect.js';

function form() {
  const value = new FormData();
  value.append('text', Buffer.from('owned bytes'), {
    contentType: 'text/plain',
  });
  return value;
}
describe('bounded encoder collection', () => {
  it.each([-1, 1])(
    'refuses a mismatching declared length (%s)',
    async (delta) => {
      const value = form();
      await expect(
        collectMultipart(
          value,
          value.getLengthSync() + delta,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_encoding' } });
    },
  );
  it('refuses an over-budget form before consuming it', async () => {
    const value = form();
    await expect(
      collectMultipart(value, 1048577, new AbortController().signal),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_size' } });
  });
  it('honors cancellation during assembly and removes its error listener', async () => {
    const value = form();
    const controller = new AbortController();
    value.once('data', () => {
      controller.abort();
    });
    await expect(
      collectMultipart(value, value.getLengthSync(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.listenerCount('error')).toBe(0);
  });
  it('sanitizes encoder errors without leaking payload details', async () => {
    const value = form();
    value.once('data', () => {
      value.emit('error', new Error('private payload'));
    });
    await expect(
      collectMultipart(
        value,
        value.getLengthSync(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'multipart_encoding' } });
    expect(value.listenerCount('error')).toBe(0);
  });
});
