import { and, count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import {
  assertFormFileSize,
  FORM_FILE_LIMITS,
  formFilename,
  formFileType,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  checkDatabaseReadiness,
  withTenantScopedClient,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import { artifacts, formUploads } from '@pertexo/database/schema';
import { discoverPublicForm } from '../../triggers/forms/store.js';
import { FormChangedError } from '../../triggers/forms/errors.js';
import { ArtifactUploadNotFoundError } from '../uploads/errors.js';
import {
  completeArtifactUpload,
  reserveArtifactUpload,
} from '../uploads/reservation.repository.js';
import { FormUploadLimitError } from './errors.js';
import { assertUnsentPublicRoom } from './unsent.queries.js';
import { FORM_UPLOAD_PURPOSE } from '../contract.js';
import type {
  BeginFormUploadInput,
  DiscoverFormInput,
  FinalizeFormUploadInput,
  FormUpload,
  FormUploadSession,
  ReadFormUploadInput,
} from './contract.js';
import {
  boundUploadsSql,
  formUploadSessionHash,
  loadUploadTarget,
  uploadTargetScope,
  type LoadedUploadTarget,
} from './targets.queries.js';

function inTarget<T>(
  pool: Pool,
  input: FormUploadSession,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    uploadTargetScope(input.target),
    work,
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

/** The field and stored type a begin request may use, checked before any bytes move. */
function acceptedFile(target: LoadedUploadTarget, input: BeginFormUploadInput) {
  if (
    target.workflowVersionId !== null &&
    input.versionId !== target.workflowVersionId
  )
    throw new FormChangedError();
  const field = target.fields.find(({ id }) => id === input.fieldId);
  if (field?.type !== 'file')
    throw new FormValuesInvalidError([
      { name: '', message: 'Upload files to a file field of this form.' },
    ]);
  const filename = formFilename(input.filename);
  const { mediaType } = formFileType(filename, field.accept);
  assertFormFileSize(input.byteLength, field.maxBytes);
  return { field, filename, mediaType };
}

async function beginFormUpload(
  pool: Pool,
  input: BeginFormUploadInput,
): Promise<FormUpload & { replayed: boolean }> {
  return inTarget(pool, input, async (client) => {
    const target = await loadUploadTarget(client, input.target, {
      write: true,
    });
    const { field, filename, mediaType } = acceptedFile(target, input);
    const sessionHash = formUploadSessionHash(input.session);
    const metadata = {
      byteLength: input.byteLength,
      mediaType,
      sha256: input.sha256,
    };
    const reserved = await reserveArtifactUpload(client, {
      workspaceId: target.workspaceId,
      purpose: FORM_UPLOAD_PURPOSE,
      scope: `form-upload:${sessionHash}`,
      idempotencyKey: input.idempotencyKey,
      requestHash: canonicalOutboxPayloadChecksum({
        operation: 'form.upload',
        workflowId: target.workflowId,
        workflowVersionId: target.workflowVersionId,
        taskId: target.taskId,
        fieldId: field.id,
        filename,
        ...metadata,
      }),
      metadata,
    });
    if (reserved.replayed)
      return {
        ...(await readBound(client, target, input, reserved.artifact.id)),
        replayed: true,
      };
    if (target.capabilityHash !== null)
      await assertUnsentPublicRoom(
        client,
        target.workspaceId,
        input.byteLength,
      );
    const db = drizzle(client);
    await db
      .insert(formUploads)
      .values({
        workspaceId: target.workspaceId,
        artifactId: reserved.artifact.id,
        workflowId: target.workflowId,
        workflowVersionId: target.workflowVersionId,
        taskId: target.taskId,
        fieldId: field.id,
        filename,
        sessionHash,
        capabilityHash: target.capabilityHash,
        uploadedBy: target.uploadedBy,
      })
      .catch(rethrowQueryFailure);
    // Counting after the insert keeps exact retries of earlier uploads working.
    const [begun] = await db
      .select({ uploads: count() })
      .from(formUploads)
      .where(
        and(
          eq(formUploads.workspaceId, target.workspaceId),
          eq(formUploads.sessionHash, sessionHash),
        ),
      )
      .catch(rethrowQueryFailure);
    if ((begun?.uploads ?? 0) > FORM_FILE_LIMITS.sessionUploads)
      throw new FormUploadLimitError('response');
    return { artifact: reserved.artifact, filename, replayed: false };
  });
}

async function readBound(
  client: PoolClient,
  target: LoadedUploadTarget,
  input: FormUploadSession,
  uploadId: string,
): Promise<FormUpload> {
  const [row] = await drizzle(client)
    .select({ artifact: artifacts, filename: formUploads.filename })
    .from(formUploads)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.workspaceId, formUploads.workspaceId),
        eq(artifacts.id, formUploads.artifactId),
      ),
    )
    .where(
      and(
        boundUploadsSql(target, input.session),
        eq(formUploads.artifactId, uploadId),
        eq(artifacts.purpose, FORM_UPLOAD_PURPOSE),
        inArray(artifacts.status, ['pending', 'available']),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  return { artifact: Object.freeze(row.artifact), filename: row.filename };
}

async function finalizeFormUpload(
  pool: Pool,
  input: FinalizeFormUploadInput,
): Promise<FormUpload> {
  return inTarget(pool, input, async (client) => {
    const target = await loadUploadTarget(client, input.target, {
      write: true,
    });
    const bound = await readBound(client, target, input, input.uploadId);
    // Completing locks the artifact row against concurrent cleanup.
    const artifact = await completeArtifactUpload(client, {
      workspaceId: target.workspaceId,
      artifactId: bound.artifact.id,
      purpose: FORM_UPLOAD_PURPOSE,
      expectedMetadata: input.expectedMetadata,
      // Unsent files go after a day, or an hour for a public link; a
      // submission's run keeps them.
      retainFor: target.capabilityHash === null ? '24 hours' : '1 hour',
    });
    return { artifact, filename: bound.filename };
  });
}

export type FormUploadStore = ReturnType<typeof createFormUploadStore>;

export function createFormUploadStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    discover: (input: DiscoverFormInput) => discoverPublicForm(pool, input),
    begin: (input: BeginFormUploadInput) => beginFormUpload(pool, input),
    read: (input: ReadFormUploadInput) =>
      inTarget(pool, input, async (client) =>
        readBound(
          client,
          await loadUploadTarget(client, input.target, { write: false }),
          input,
          input.uploadId,
        ),
      ),
    finalize: (input: FinalizeFormUploadInput) =>
      finalizeFormUpload(pool, input),
    checkReadiness: () => checkDatabaseReadiness(pool),
    close: lease.close,
  });
}
