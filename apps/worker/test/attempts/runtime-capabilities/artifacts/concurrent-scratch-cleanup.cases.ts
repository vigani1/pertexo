import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  context,
  databaseConfig,
  temporaryDirectories,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerConcurrentScratchCleanup(): void {
  it('cleans after simultaneous metadata and directory-removal failures and reports no private adapter details', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const createPending = vi
      .fn()
      .mockRejectedValue(new Error('private metadata failure'));
    const removeDirectory = vi
      .fn()
      .mockRejectedValue(new Error('private directory path'));
    const put = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: { createPending, finalize: vi.fn() },
        artifactStore: { put },
        spoolDirectory,
        artifactSpoolOperations: {
          openFile: (file) => open(file, 'wx', 0o600),
          removeDirectory,
        },
      },
    );
    try {
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined) throw new Error('Artifacts missing');
      const bytes = new Uint8Array([1]);
      const result: unknown = await artifacts
        .write({
          body: (async function* () {
            yield await Promise.resolve(bytes);
          })(),
          maxBytes: 1,
          mediaType: 'text/plain',
          purpose: 'node-output',
          signal: new AbortController().signal,
        })
        .catch((error: unknown) => error);
      expect(result).toMatchObject({
        safeErrorCode: 'execution.file_scratch_cleanup',
      });
      expect(createPending).toHaveBeenCalledTimes(1);
      expect(removeDirectory).toHaveBeenCalledTimes(1);
      expect(put).not.toHaveBeenCalled();
      expect(bytes).toEqual(new Uint8Array([0]));
      expect(JSON.stringify(result)).not.toContain('private');
    } finally {
      await runtime.close();
    }
  });
}
