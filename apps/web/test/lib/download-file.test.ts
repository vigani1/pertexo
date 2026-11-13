import { afterEach, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_URL_LIFETIME_MS,
  downloadTextFile,
} from '@/lib/download-file';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('saves the text under its name and keeps the URL until the download has started', async () => {
  vi.useFakeTimers();
  const saved: Blob[] = [];
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (blob instanceof Blob) saved.push(blob);
    return 'blob:download';
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  const clicked: { name: string; href: string; inDocument: boolean }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({
      name: this.download,
      href: this.getAttribute('href') ?? '',
      inDocument: document.body.contains(this),
    });
  });
  downloadTextFile({
    name: 'pertexo-recovery-codes.txt',
    type: 'text/plain;charset=utf-8',
    text: 'one\ntwo\n',
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(clicked).toEqual([
    {
      name: 'pertexo-recovery-codes.txt',
      href: 'blob:download',
      inDocument: true,
    },
  ]);
  expect(await saved[0]?.text()).toBe('one\ntwo\n');
  expect(saved[0]?.type).toBe('text/plain;charset=utf-8');
  // The link goes, but the URL outlives the browser's read of it.
  expect(document.querySelector('a[download]')).toBeNull();
  vi.advanceTimersByTime(DOWNLOAD_URL_LIFETIME_MS - 1);
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revoke).toHaveBeenCalledWith('blob:download');
  expect(DOWNLOAD_URL_LIFETIME_MS).toBeGreaterThanOrEqual(10_000);
});
