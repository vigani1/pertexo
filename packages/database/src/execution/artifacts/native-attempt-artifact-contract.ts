import { z } from 'zod';
import { readCallDeclarationInputSchema } from '../node-attempts/node-attempt-run-store-contract.js';
import type { NodeAttemptLease } from '../node-attempts/node-attempt-run-store-contract.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from './execution-value-representation.js';

const ownerSchema = z
  .object({
    kind: z.literal('attempt'),
    slot: z.enum(['call_input', 'physical_output']),
    lease: readCallDeclarationInputSchema.shape.lease,
  })
  .strict();
const valueMetadataSchema = z
  .object({
    byteLength: z.number().int().min(1).max(1_048_576),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mediaType: z.literal(WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1),
  })
  .strict();
export const nativeAttemptArtifactReservationSchema = valueMetadataSchema
  .extend({
    owner: ownerSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
export const nativeAttemptArtifactMetadataSchema = valueMetadataSchema
  .extend({
    artifactId: z.uuid(),
    workspaceId: z.uuid(),
    available: z.boolean(),
  })
  .strict();
export const nativeAttemptArtifactProofSchema = z
  .object({
    owner: ownerSchema,
    reserved: nativeAttemptArtifactMetadataSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
export const nativeAttemptArtifactPreparationSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('missing'),
        expiresAt: z.coerce
          .date()
          .refine((date) => Number.isFinite(date.getTime())),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ready'),
        reservation: nativeAttemptArtifactMetadataSchema,
      })
      .strict(),
    z.object({ kind: z.literal('preparation_unavailable') }).strict(),
  ],
);

type NativeAttemptArtifactProducer = Readonly<{
  kind: 'attempt';
  slot: 'call_input' | 'physical_output';
  lease: NodeAttemptLease;
}>;
export type NativeAttemptArtifactReservationInput = Readonly<{
  owner: NativeAttemptArtifactProducer;
  byteLength: number;
  sha256: string;
  mediaType: typeof WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1;
  signal: AbortSignal;
}>;
export type NativeAttemptArtifactProofInput = Readonly<{
  owner: NativeAttemptArtifactProducer;
  reserved: NativeAttemptArtifactMetadata;
  signal: AbortSignal;
}>;
export type NativeAttemptArtifactMetadata = Readonly<
  z.output<typeof nativeAttemptArtifactMetadataSchema>
>;

/** Retry/backoff must resolve the old candidate; never overwrite it or recharge. */
export class NativeArtifactPreparationUnavailableError extends Error {
  public readonly code = 'preparation_unavailable' as const;
  public constructor() {
    super('Native artifact preparation is unavailable');
    this.name = 'NativeArtifactPreparationUnavailableError';
  }
}
