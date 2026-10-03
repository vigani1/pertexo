import type { ArtifactStore } from '@pertexo/artifact-store';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '@pertexo/database/execution';
import type {
  CoordinatorAdvanceDelivery,
  NodeAttemptLease,
  StoredExecutionValueV1,
  NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import { NODE_JSON_LIMITS_V1, type SchemaJson } from '@pertexo/node-sdk';
import { z } from 'zod';

export { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 };

export type WorkflowStoredExecutionValueV1 = StoredExecutionValueV1;
type ArtifactReference = Extract<
  WorkflowStoredExecutionValueV1,
  { kind: 'artifact' }
>;
export type WorkflowExecutionValueOwner =
  | Readonly<{ kind: 'attempt'; lease: NodeAttemptLease }>
  | Readonly<{
      kind: 'run_result';
      workspaceId: string;
      runId: string;
      workflowVersionId: string;
      expectedRevision: number;
      delivery: CoordinatorAdvanceDelivery;
    }>;

/** Production identity is distinct from the authority consuming an accepted value. */
export type WorkflowExecutionValueProducerOwner =
  | Readonly<{
      kind: 'attempt';
      slot: 'call_input' | 'physical_output';
      lease: NodeAttemptLease;
    }>
  | (Extract<WorkflowExecutionValueOwner, { kind: 'run_result' }> &
      Readonly<{ resultRevision: number; resultIdentity: string }>);

/** Validate routing metadata only; persistence still proves actual owner authority. */
export function assertWorkflowExecutionValueProducer(
  owner: WorkflowExecutionValueProducerOwner,
): void {
  if (owner.kind === 'attempt') {
    const slot: unknown = owner.slot;
    if (slot !== 'call_input' && slot !== 'physical_output')
      throw new TypeError('Execution value producer slot is required');
    return;
  }
  if (
    !Number.isSafeInteger(owner.expectedRevision) ||
    owner.expectedRevision < 0 ||
    !Number.isSafeInteger(owner.resultRevision) ||
    owner.resultRevision !== owner.expectedRevision + 1 ||
    typeof owner.resultIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(owner.resultIdentity)
  )
    throw new TypeError('Execution value result producer identity is invalid');
}

export const metadataSchema = z
  .object({
    artifactId: z.uuid(),
    workspaceId: z.uuid(),
    byteLength: z.number().int().min(1).max(NODE_JSON_LIMITS_V1.bytes),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mediaType: z.literal(WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1),
  })
  .strict();
export const reservationSchema = metadataSchema
  .extend({ available: z.boolean() })
  .strict();
export type WorkflowExecutionValueArtifact = Readonly<
  z.infer<typeof reservationSchema>
>;
export interface PreparedWorkflowExecutionValue {
  readonly reference: WorkflowStoredExecutionValueV1;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface WorkflowExecutionValueCodecDependencies {
  /** The existing 256KiB inline persistence owner decides eligibility. */
  readonly chooseInline: (
    value: SchemaJson,
  ) => Extract<WorkflowStoredExecutionValueV1, { kind: 'inline' }> | undefined;
  /** Prove current producer authority in SQL; exact retries reuse the same candidate without another charge. */
  readonly reserve: (
    input: Readonly<{
      owner: WorkflowExecutionValueProducerOwner;
      byteLength: number;
      sha256: string;
      mediaType: typeof WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  /** Adapter MUST delegate the existing node-artifact-runtime writer: no second put/quota/spool owner. */
  readonly writeReserved: (
    input: Readonly<{
      owner: WorkflowExecutionValueProducerOwner;
      reserved: WorkflowExecutionValueArtifact;
      body: AsyncIterable<Uint8Array>;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  /** Prove accepted, immutable, same-workspace execution provenance before a read; candidate availability is insufficient. */
  readonly authorize: (
    input: Readonly<{
      owner: WorkflowExecutionValueOwner;
      reference: ArtifactReference;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  readonly store: Pick<ArtifactStore, 'getStream'>;
  /** Resolve this exact accepted source and eligibility under current consumption authority; candidate possession is insufficient. */
  readonly authorizeSource?: (
    input: Readonly<{
      owner: WorkflowExecutionValueOwner;
      source: NativeNodeAttemptValueSource;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
}
