import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';
import {
  ArtifactService,
  ArtifactUploadTooLargeError,
} from '../../../src/artifacts/index.js';

import { record, dependencies, context, uploadRequest } from './fixture.js';

export function registerAcceptsExact10MiBCeilingRefuses(): void {
  it('accepts the exact 10 MiB ceiling and refuses one byte over before reserving, even with a larger store', async () => {
    const maximum = 10485760;
    const deps = dependencies({
      beginUpload: vi.fn().mockResolvedValue({
        artifact: record({ byteLength: maximum }),
        replayed: false,
      }),
    });
    const instance = new ArtifactService(deps, {
      maxObjectBytes: 100 * 1024 * 1024,
      now: () => new Date('2026-09-06T00:00:00Z'),
    });
    await instance.beginUpload({
      ...context(),
      request: { ...uploadRequest, byteLength: maximum },
      idempotencyKey: randomUUID(),
    });
    expect(deps.database.beginUpload).toHaveBeenCalledOnce();
    await expect(
      instance.beginUpload({
        ...context(),
        request: { ...uploadRequest, byteLength: maximum + 1 },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadTooLargeError);
    expect(deps.database.beginUpload).toHaveBeenCalledOnce();
  });
}
