import { ArtifactNotFoundError } from '@pertexo/artifact-store';

import { expect, it, vi } from 'vitest';
import { ArtifactApiNotFoundError } from '../../../src/artifacts/index.js';

import {
  artifactId,
  record,
  dependencies,
  context,
  service,
} from './fixture.js';

export function registerArtifactServiceConcealsSArtifactMetadata(): void {
  it.each([
    ['missing', null],
    ['deleting', record({ status: 'deleting' })],
    ['deleted', record({ status: 'deleted' })],
  ] as const)('conceals %s artifact metadata', async (_case, artifact) => {
    const deps = dependencies({
      getMetadata: vi.fn().mockResolvedValue(artifact),
    });

    await expect(
      service(deps).getMetadata({ ...context(), artifactId }),
    ).rejects.toBeInstanceOf(ArtifactApiNotFoundError);
  });

  it('does not mint a download capability for a pending artifact', async () => {
    const deps = dependencies();

    await expect(
      service(deps).beginDownload({ ...context(), artifactId }),
    ).rejects.toBeInstanceOf(ArtifactApiNotFoundError);
    expect(deps.store.beginDirectDownload).not.toHaveBeenCalled();
  });

  it('maps a missing object during verification to a conflict', async () => {
    const deps = dependencies(
      {},
      {
        validateDirectUpload: vi
          .fn()
          .mockRejectedValue(new ArtifactNotFoundError()),
      },
    );

    await expect(
      service(deps).finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
}
