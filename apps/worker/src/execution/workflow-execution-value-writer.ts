import type { ArtifactStore } from '@pertexo/artifact-store';
import { artifactStorageKey } from '@pertexo/database/execution';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';

import {
  createNodeArtifactRuntimeFactory,
  type ArtifactSpoolOperations,
  type WorkerArtifactPersistence,
} from './node-artifact-runtime.js';
import { assertUploadedArtifactMatches } from './node-artifact-policy.js';
import {
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  assertWorkflowExecutionValueProducer,
  type WorkflowExecutionValueCodecDependencies,
} from './workflow-execution-value-contract.js';

type WriteReservedInput = Parameters<
  WorkflowExecutionValueCodecDependencies['writeReserved']
>[0];
type ReservationProofInput = Pick<
  WriteReservedInput,
  'owner' | 'reserved' | 'signal'
>;

export interface WorkflowExecutionValueWriterPersistence {
  /** Verify the existing reservation under its actual lease/delivery proof. Never insert or charge again. */
  assertReserved(input: ReservationProofInput): Promise<void>;
  /** Finalize that same reservation through the existing artifact lifecycle owner. */
  finalize(input: ReservationProofInput): Promise<void>;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Framework-only adapter. The codec supplies admitted own-data metadata; SQL
 * callbacks retain lease/delivery and durable reservation lifecycle authority.
 * No artifact capability is granted to a Call executor.
 */
export function createWorkflowExecutionValueWriter(
  dependencies: Readonly<{
    persistence: WorkflowExecutionValueWriterPersistence;
    store: Pick<ArtifactStore, 'put'>;
    retentionMillis: number;
    now?: () => Date;
    spoolDirectory?: string;
    spoolOperations?: ArtifactSpoolOperations;
  }>,
): WorkflowExecutionValueCodecDependencies['writeReserved'] {
  return async (input) => {
    assertActive(input.signal);
    assertWorkflowExecutionValueProducer(input.owner);
    const reserved = Object.freeze({ ...input.reserved });
    const mediaType: unknown = reserved.mediaType;
    const workspaceId =
      input.owner.kind === 'attempt'
        ? input.owner.lease.workspaceId
        : input.owner.workspaceId;
    if (
      reserved.available ||
      reserved.workspaceId !== workspaceId ||
      mediaType !== WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 ||
      !Number.isSafeInteger(reserved.byteLength) ||
      reserved.byteLength < 1 ||
      reserved.byteLength > NODE_JSON_LIMITS_V1.bytes ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < reserved.byteLength ||
      input.maxBytes > NODE_JSON_LIMITS_V1.bytes
    )
      throw new TypeError('Execution value reservation is not writable');
    const proof: ReservationProofInput = Object.freeze({
      owner: input.owner,
      reserved,
      signal: input.signal,
    });
    const storageKey = artifactStorageKey(workspaceId, reserved.artifactId);
    const persistence: WorkerArtifactPersistence = {
      createPending: async (computed) => {
        assertUploadedArtifactMatches(computed, reserved);
        if (computed.storageKey !== storageKey)
          throw new TypeError(
            'Execution value reservation storage key mismatch',
          );
        // Legacy expiresAt/purpose are deliberately ignored: retentionMillis
        // cannot establish or extend the SQL owner's existing reservation expiry.
        await dependencies.persistence.assertReserved(proof);
      },
      finalize: async (computed) => {
        assertUploadedArtifactMatches(computed, reserved);
        await dependencies.persistence.finalize(proof);
      },
    };
    const runtime = createNodeArtifactRuntimeFactory({
      ...dependencies,
      persistence,
      artifactId: () => reserved.artifactId,
    })({ workspaceId });
    const uploaded = await runtime.write({
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      purpose: 'execution-value',
      body: input.body,
      maxBytes: input.maxBytes,
      signal: input.signal,
    });
    assertActive(input.signal);
    return Object.freeze({ ...uploaded, workspaceId });
  };
}
