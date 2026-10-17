import { Logger } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { CsvExportAdmission } from '../../src/platform/http/csv/admission.js';

function slots() {
  const active = new Set<string>();
  return {
    acquireExclusiveSlot: vi.fn((scope: string) => {
      if (active.has(scope)) return Promise.resolve(null);
      active.add(scope);
      return Promise.resolve({
        release: () => {
          active.delete(scope);
          return Promise.resolve(undefined);
        },
      });
    }),
  };
}
it('refuses concurrent workspace exports across instances and releases after failure', async () => {
  const backend = slots();
  const first = new CsvExportAdmission(backend);
  const second = new CsvExportAdmission(backend);
  const opened = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const running = first.run('workspace', async () => {
    opened.resolve(undefined);
    await release.promise;
    throw new Error('download lost');
  });
  const failed = expect(running).rejects.toThrow('download lost');
  try {
    await opened.promise;
    await expect(
      second.run('workspace', () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: 'workspace.conflict',
      safeDetail: expect.stringContaining(
        'export is already running',
      ) as unknown,
    });
    await expect(
      second.run('another', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  } finally {
    release.resolve(undefined);
    await failed;
  }
  await expect(
    second.run('workspace', () => Promise.resolve('ok')),
  ).resolves.toBe('ok');
});
it('caps each instance at two and does not acquire another workspace slot', async () => {
  const backend = slots();
  const admission = new CsvExportAdmission(backend);
  const release = Promise.withResolvers<undefined>();
  const opened = Promise.withResolvers<undefined>();
  let count = 0;
  const work = () => {
    if (++count === 2) opened.resolve(undefined);
    return release.promise;
  };
  const running = [admission.run('one', work), admission.run('two', work)];
  try {
    await opened.promise;
    await expect(
      admission.run('three', () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: 'workspace.conflict',
      safeDetail: expect.stringContaining(
        'export is already running',
      ) as unknown,
    });
    expect(backend.acquireExclusiveSlot).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve(undefined);
    await Promise.all(running);
  }
  await expect(
    admission.run('three', () => Promise.resolve()),
  ).resolves.toBeUndefined();
});
it('fails closed on backend failure without consuming instance capacity', async () => {
  const backend = slots();
  backend.acquireExclusiveSlot.mockRejectedValueOnce(new Error('offline'));
  const admission = new CsvExportAdmission(backend);
  const work = vi.fn(() => Promise.resolve());
  await expect(admission.run('one', work)).rejects.toMatchObject({
    code: 'request.rate_limit_unavailable',
  });
  expect(work).not.toHaveBeenCalled();
  await expect(admission.run('one', work)).resolves.toBeUndefined();
});

it('keeps the download outcome when Redis closes before slot cleanup', async () => {
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  const admission = new CsvExportAdmission({
    acquireExclusiveSlot: () =>
      Promise.resolve({
        release: () => Promise.reject(new Error('runtime closed')),
      }),
  });
  try {
    await expect(
      admission.run('one', () => Promise.resolve('complete')),
    ).resolves.toBe('complete');
    await expect(
      admission.run('one', () => Promise.reject(new Error('download failed'))),
    ).rejects.toThrow('download failed');
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});
