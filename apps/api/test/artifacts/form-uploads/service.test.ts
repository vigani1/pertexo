import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactIntegrityError } from '@pertexo/artifact-store';
import type { FormUploadTarget } from '@pertexo/core/artifacts';
import { FormFileRejectedError } from '@pertexo/workflow-model';
import {
  ArtifactApiConflictError,
  ArtifactUploadDeadlineError,
  ArtifactUploadTooLargeError,
  type ArtifactStore,
  type FormUploadStore,
} from '../../../src/artifacts/index.js';
import { FormUploadService } from '../../../src/artifacts/form-uploads/service.js';
import { record } from '../service/fixture.js';

const now = new Date('2026-09-06T00:00:00.000Z');
const target: FormUploadTarget = {
  kind: 'member_form',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const session = 'S'.repeat(43);
const pdf = record({ purpose: 'form-upload', mediaType: 'application/pdf' });

function setup(
  options: Readonly<{
    filename?: string;
    bytes?: string;
    artifact?: ReturnType<typeof record>;
  }> = {},
) {
  const bound = {
    artifact: options.artifact ?? pdf,
    filename: options.filename ?? 'invoice.pdf',
  };
  const database = {
    discover: vi.fn(),
    begin: vi.fn().mockResolvedValue({ ...bound, replayed: false }),
    read: vi.fn().mockResolvedValue(bound),
    finalize: vi.fn().mockResolvedValue({
      ...bound,
      artifact: { ...bound.artifact, status: 'available' },
    }),
  } satisfies FormUploadStore;
  const store = {
    beginDirectUpload: vi.fn().mockResolvedValue({
      expiresAt: '2026-09-06T00:15:00.000Z',
      expiresInSeconds: 900,
      headers: { 'content-type': 'application/pdf' },
      method: 'PUT',
      url: 'https://objects.example.test/upload',
    }),
    validateDirectUpload: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(() =>
      Promise.resolve({
        body: Readable.from([Buffer.from(options.bytes ?? '%PDF-1.7\n')]),
        metadata: {
          artifactId: bound.artifact.id,
          workspaceId: bound.artifact.workspaceId,
          byteLength: bound.artifact.byteLength,
          mediaType: bound.artifact.mediaType,
          sha256: bound.artifact.sha256,
        },
      }),
    ),
    beginDirectDownload: vi.fn(),
    checkReadiness: vi.fn(),
    close: vi.fn(),
  } satisfies ArtifactStore;
  const service = new FormUploadService(
    { database, store },
    { maxObjectBytes: 10_485_760, now: () => now },
  );
  return { database, store, service };
}

const begin = {
  target,
  session,
  versionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  fieldId: 'invoice',
  filename: 'invoice.pdf',
  byteLength: 4,
  sha256: 'a'.repeat(64),
  idempotencyKey: 'begin-1',
};

describe('form upload service', () => {
  it('reserves through the response binding, then signs one PUT for it', async () => {
    const { database, store, service } = setup();
    await expect(service.begin(begin)).resolves.toEqual({
      upload: {
        id: pdf.id,
        filename: 'invoice.pdf',
        byteLength: 4,
        mediaType: 'application/pdf',
        status: 'pending',
        expiresAt: pdf.expiresAt.toISOString(),
      },
      transfer: expect.objectContaining({ method: 'PUT' }) as unknown,
      replayed: false,
    });
    expect(database.begin).toHaveBeenCalledWith(begin);
    expect(store.beginDirectUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: pdf.id,
        mediaType: 'application/pdf',
      }),
    );
  });

  it('refuses a file over the server limit before reserving', async () => {
    const { database, service } = setup();
    await expect(
      service.begin({ ...begin, byteLength: 10_485_761 }),
    ).rejects.toThrow(ArtifactUploadTooLargeError);
    expect(database.begin).not.toHaveBeenCalled();
  });

  it('never signs another PUT for a finalized upload', async () => {
    const { database, store, service } = setup();
    database.begin.mockResolvedValue({
      artifact: { ...pdf, status: 'available' },
      filename: 'invoice.pdf',
      replayed: true,
    });
    await expect(service.begin(begin)).rejects.toThrow(
      ArtifactApiConflictError,
    );
    expect(store.beginDirectUpload).not.toHaveBeenCalled();
  });

  it('verifies size, fingerprint and type before making the file usable', async () => {
    const { database, store, service } = setup();
    await expect(
      service.finalize({ target, session, uploadId: pdf.id }),
    ).resolves.toMatchObject({ id: pdf.id, status: 'available' });
    expect(store.validateDirectUpload).toHaveBeenCalledOnce();
    expect(database.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: pdf.id, expectedMetadata: pdf }),
    );
  });

  it.each([
    ['a web page named as a PDF', 'invoice.pdf', '<html><script>'],
    ['a program named as a CSV', 'rows.csv', 'MZ\u0000\u0000\u0003'],
  ])('refuses %s', async (_name, filename, bytes) => {
    const { database, service } = setup({ filename, bytes });
    await expect(
      service.finalize({ target, session, uploadId: pdf.id }),
    ).rejects.toThrow(FormFileRejectedError);
    expect(database.finalize).not.toHaveBeenCalled();
  });

  it('refuses stored bytes that differ from the reservation', async () => {
    const { database, store, service } = setup();
    store.validateDirectUpload.mockRejectedValue(
      new ArtifactIntegrityError('mismatch'),
    );
    await expect(
      service.finalize({ target, session, uploadId: pdf.id }),
    ).rejects.toThrow(ArtifactApiConflictError);
    expect(database.finalize).not.toHaveBeenCalled();
  });

  it('repeats a finished finalize without touching storage, and refuses an expired one', async () => {
    const available = setup({ artifact: { ...pdf, status: 'available' } });
    await expect(
      available.service.finalize({ target, session, uploadId: pdf.id }),
    ).resolves.toMatchObject({ status: 'available' });
    expect(available.store.validateDirectUpload).not.toHaveBeenCalled();
    const expired = setup({ artifact: { ...pdf, expiresAt: now } });
    await expect(
      expired.service.finalize({ target, session, uploadId: pdf.id }),
    ).rejects.toThrow(ArtifactUploadDeadlineError);
  });
});
