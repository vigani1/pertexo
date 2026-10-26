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
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { checkDatabaseReadiness } from '../../platform/readiness.queries.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { artifacts } from '../../schema/transport.js';
import { formUploads } from '../../schema/triggers/forms.js';
import { discoverPublicForm } from '../../triggers/forms/repository.js';
import { FormChangedError } from '../../triggers/forms/errors.js';
import { ArtifactUploadNotFoundError } from '../uploads/input.js';
import {
  completeArtifactUpload,
  reserveArtifactUpload,
} from '../uploads/reservation.repository.js';
import { FormUploadLimitError } from './errors.js';
import type {
  BeginFormUploadInput,
  FormUpload,
  FormUploadDatabase,
  FormUploadSession,
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
      purpose: 'form-upload',
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
      throw new FormUploadLimitError();
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
        eq(artifacts.purpose, 'form-upload'),
        inArray(artifacts.status, ['pending', 'available']),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  return { artifact: Object.freeze(row.artifact), filename: row.filename };
}

async function finalizeFormUpload(
  pool: Pool,
  input: Parameters<FormUploadDatabase['finalize']>[0],
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
      purpose: 'form-upload',
      expectedMetadata: input.expectedMetadata,
      // Unsubmitted files go after a day; a submission's run keeps them.
      retainFor: '24 hours',
    });
    return { artifact, filename: bound.filename };
  });
}

export function createFormUploadDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): FormUploadDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    discover: (input) => discoverPublicForm(pool, input),
    begin: (input) => beginFormUpload(pool, input),
    read: (input) =>
      inTarget(pool, input, async (client) =>
        readBound(
          client,
          await loadUploadTarget(client, input.target, { write: false }),
          input,
          input.uploadId,
        ),
      ),
    finalize: (input) => finalizeFormUpload(pool, input),
    checkReadiness: () => checkDatabaseReadiness(pool),
    close: lease.close,
  } satisfies FormUploadDatabase);
}
