import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../../tenant-access/workspace.js';
import { workflowCallAttemptAuthorityJson } from '../node-attempts/node-attempt-call-input-record.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from '../node-attempts/node-attempt-run-store-transactions.js';
import {
  artifactStorageKey,
  createPendingArtifact,
  finalizeArtifactUpload,
} from './artifacts.js';
import {
  nativeAttemptArtifactReservationSchema,
  nativeAttemptArtifactProofSchema,
  nativeAttemptArtifactPreparationSchema,
  NativeArtifactPreparationUnavailableError,
  type NativeAttemptArtifactReservationInput,
  type NativeAttemptArtifactProofInput,
  type NativeAttemptArtifactMetadata,
} from './native-attempt-artifact-contract.js';

async function prepareCandidate(
  client: PoolClient,
  input: z.output<typeof nativeAttemptArtifactReservationSchema>,
  expectedArtifactId: string | null = null,
) {
  assertNotAborted(input.signal);
  const rows = await client.query<{ result: unknown }>(
    'select app.prepare_native_attempt_artifact_candidate($1::jsonb,$2::text,$3::text,$4::integer,$5::text,$6::uuid) as result',
    [
      workflowCallAttemptAuthorityJson(input.owner.lease),
      input.owner.slot,
      input.sha256,
      input.byteLength,
      input.mediaType,
      expectedArtifactId,
    ],
  );
  assertNotAborted(input.signal);
  if (rows.rows.length !== 1)
    throw new Error('Native artifact preparation response is missing');
  const result = nativeAttemptArtifactPreparationSchema.parse(
    rows.rows[0]?.result,
  );
  if (result.kind === 'preparation_unavailable')
    throw new NativeArtifactPreparationUnavailableError();
  if (result.kind === 'ready') {
    const reservation = result.reservation;
    if (
      reservation.workspaceId !== input.owner.lease.workspaceId ||
      reservation.sha256 !== input.sha256 ||
      reservation.byteLength !== input.byteLength ||
      (expectedArtifactId !== null &&
        reservation.artifactId !== expectedArtifactId)
    )
      throw new Error('Native artifact independently proved metadata differs');
  }
  return result;
}

/** One short current-producer transaction; never holds locks across spool/upload. */
export async function reserveNativeAttemptArtifact(
  pool: Pool,
  request: NativeAttemptArtifactReservationInput,
): Promise<NativeAttemptArtifactMetadata> {
  const input = nativeAttemptArtifactReservationSchema.parse(request);
  assertNotAborted(input.signal);
  return withWorkspaceWriteClient(
    pool,
    input.owner.lease.workspaceId,
    input.signal,
    async (client) => {
      // Protected preparation acquires workspace/ancestors/current lease/candidate
      // before existing artifact/capacity lifecycle work on this exact client.
      const prepared = await prepareCandidate(client, input);
      if (prepared.kind === 'ready') return Object.freeze(prepared.reservation);
      const artifactId = generatePersistedId();
      const transaction = workspaceTransactionFromClient(
        client,
        parseWorkspaceId(input.owner.lease.workspaceId),
      );
      await createPendingArtifact(transaction, {
        artifactId,
        storageKey: artifactStorageKey(
          input.owner.lease.workspaceId,
          artifactId,
        ),
        sha256: input.sha256,
        byteLength: input.byteLength,
        mediaType: input.mediaType,
        purpose: 'execution-value',
        expiresAt: prepared.expiresAt,
      });
      assertNotAborted(input.signal);
      // Registration reruns actual producer proof and checks existing metadata;
      // failure rolls back BOTH artifact and candidate, with no accepted parent.
      const registered = await client.query<{ result: unknown }>(
        'select app.register_native_attempt_artifact_candidate($1::jsonb,$2::text,$3::uuid,$4::uuid,$5::text,$6::integer,$7::text) as result',
        [
          workflowCallAttemptAuthorityJson(input.owner.lease),
          input.owner.slot,
          generatePersistedId(),
          artifactId,
          input.sha256,
          input.byteLength,
          input.mediaType,
        ],
      );
      assertNotAborted(input.signal);
      if (registered.rows.length !== 1)
        throw new Error('Native artifact registration response is missing');
      const result = nativeAttemptArtifactPreparationSchema.parse(
        registered.rows[0]?.result,
      );
      if (
        result.kind !== 'ready' ||
        result.reservation.artifactId !== artifactId ||
        result.reservation.workspaceId !== input.owner.lease.workspaceId ||
        result.reservation.sha256 !== input.sha256 ||
        result.reservation.byteLength !== input.byteLength ||
        result.reservation.available
      )
        throw new Error('Native artifact registration metadata differs');
      return Object.freeze(result.reservation);
    },
  );
}

/** Independently revalidate the same reservation; no insert or second charge. */
export async function inspectNativeAttemptArtifact(
  pool: Pool,
  request: NativeAttemptArtifactProofInput,
  finalize = false,
): Promise<void> {
  const input = nativeAttemptArtifactProofSchema.parse(request);
  if (input.reserved.workspaceId !== input.owner.lease.workspaceId)
    throw new Error('Native artifact workspace differs');
  assertNotAborted(input.signal);
  await withWorkspaceWriteClient(
    pool,
    input.owner.lease.workspaceId,
    input.signal,
    async (client) => {
      const result = await prepareCandidate(
        client,
        {
          owner: input.owner,
          byteLength: input.reserved.byteLength,
          sha256: input.reserved.sha256,
          mediaType: input.reserved.mediaType,
          signal: input.signal,
        },
        input.reserved.artifactId,
      );
      if (result.kind !== 'ready')
        throw new Error('Native artifact reservation is missing');
      if (finalize) {
        await finalizeArtifactUpload(
          workspaceTransactionFromClient(
            client,
            parseWorkspaceId(input.owner.lease.workspaceId),
          ),
          {
            artifactId: result.reservation.artifactId,
            workspaceId: result.reservation.workspaceId,
            storageKey: artifactStorageKey(
              result.reservation.workspaceId,
              result.reservation.artifactId,
            ),
            sha256: result.reservation.sha256,
            byteLength: result.reservation.byteLength,
            mediaType: result.reservation.mediaType,
          },
        );
        assertNotAborted(input.signal);
      }
    },
  );
}
