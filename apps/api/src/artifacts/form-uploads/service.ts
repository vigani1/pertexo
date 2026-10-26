import type { Readable } from 'node:stream';
import type {
  FormUploadMetadata,
  FormUploadResponse,
} from '@pertexo/contracts';
import type { FormUpload, FormUploadTarget } from '@pertexo/database/runs';
import {
  FORM_FILE_LIMITS,
  FormFileRejectedError,
  formFileExtension,
  formFileMatchesType,
} from '@pertexo/workflow-model';
import {
  ArtifactApiConflictError,
  ArtifactUploadDeadlineError,
} from '../errors.js';
import type { FormUploadDatabase } from '../ports.js';
import type { ArtifactStore } from '../store-port.js';
import {
  assertUploadSize,
  signArtifactUpload,
  storageFailure,
  verifyDirectUpload,
} from '../transfer.js';

type FormUploadSession = Readonly<{
  target: FormUploadTarget;
  session: string;
  signal?: AbortSignal;
}>;

/**
 * Responders' uploads ride the artifact transfer: a bound reservation, a direct
 * PUT, then size, fingerprint and type checks before the file becomes usable.
 */
export class FormUploadService {
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: Readonly<{
      database: FormUploadDatabase;
      store: ArtifactStore;
    }>,
    private readonly options: Readonly<{
      maxObjectBytes: number;
      now?: () => Date;
    }>,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public discover(input: Parameters<FormUploadDatabase['discover']>[0]) {
    return this.dependencies.database.discover(input);
  }

  public async begin(
    input: Parameters<FormUploadDatabase['begin']>[0],
  ): Promise<FormUploadResponse> {
    assertUploadSize(input.byteLength, this.options.maxObjectBytes);
    const created = await this.dependencies.database.begin(input);
    // A finalized identity never gets a fresh PUT capability.
    if (created.artifact.status !== 'pending')
      throw new ArtifactApiConflictError(
        'This upload has already been finalized',
      );
    const transfer = await signArtifactUpload(
      this.dependencies.store,
      created.artifact,
      this.now(),
      input.signal,
    );
    return {
      upload: { ...metadata(created), status: 'pending' },
      transfer,
      replayed: created.replayed,
    };
  }

  public async finalize(
    input: FormUploadSession & Readonly<{ uploadId: string }>,
  ): Promise<FormUploadMetadata> {
    const bound = await this.dependencies.database.read(input);
    if (bound.artifact.status === 'available') return metadata(bound);
    if (bound.artifact.expiresAt.getTime() <= this.now().getTime())
      throw new ArtifactUploadDeadlineError();
    await verifyDirectUpload(
      this.dependencies.store,
      bound.artifact,
      input.signal,
    );
    await this.assertType(bound, input.signal);
    return metadata(
      await this.dependencies.database.finalize({
        ...input,
        expectedMetadata: bound.artifact,
      }),
    );
  }

  /** The first bytes must look like the file the name claims. */
  private async assertType(
    bound: FormUpload,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const extension = formFileExtension(bound.filename);
    let head: Uint8Array;
    try {
      const download = await this.dependencies.store.getStream({
        artifactId: bound.artifact.id,
        workspaceId: bound.artifact.workspaceId,
        ...(signal === undefined ? {} : { signal }),
      });
      head = await readHead(download.body, FORM_FILE_LIMITS.sniffBytes);
    } catch (error: unknown) {
      throw storageFailure(error, 'store');
    }
    if (extension === undefined || !formFileMatchesType(extension, head))
      throw new FormFileRejectedError(
        'type',
        `This file’s contents don’t match its .${extension ?? 'file'} name. Choose the original file.`,
      );
  }
}

async function readHead(body: Readable, size: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      chunks.push(bytes);
      length += bytes.length;
      if (length >= size) break;
    }
  } finally {
    body.destroy();
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, size));
}

function metadata(upload: FormUpload): FormUploadMetadata {
  return {
    id: upload.artifact.id,
    filename: upload.filename,
    byteLength: upload.artifact.byteLength,
    mediaType: upload.artifact.mediaType,
    status: upload.artifact.status === 'available' ? 'available' : 'pending',
    expiresAt: upload.artifact.expiresAt.toISOString(),
  };
}
