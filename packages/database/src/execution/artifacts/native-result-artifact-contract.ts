import { z } from 'zod';
import { coordinatorDeliverySchema } from '../coordinator/coordinator-run-store-contract.js';
import {
  nativeAttemptArtifactMetadataSchema,
  nativeAttemptArtifactReservationSchema,
} from './native-attempt-artifact-contract.js';

/** Producer identity routes preparation; actual SQL proves current authority. */
export const nativeResultArtifactProducerSchema = z
  .object({
    kind: z.literal('run_result'),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    workflowVersionId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    resultRevision: z.number().int().min(1).max(2_147_483_647),
    resultIdentity: z.string().regex(/^[0-9a-f]{64}$/u),
    delivery: coordinatorDeliverySchema,
  })
  .strict()
  .refine((owner) => owner.resultRevision === owner.expectedRevision + 1);

export const nativeResultArtifactReservationSchema =
  nativeAttemptArtifactReservationSchema.extend({
    owner: nativeResultArtifactProducerSchema,
  });
export const nativeResultArtifactProofSchema = z
  .object({
    owner: nativeResultArtifactProducerSchema,
    reserved: nativeAttemptArtifactMetadataSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

export type NativeResultArtifactProducer = Readonly<
  z.output<typeof nativeResultArtifactProducerSchema>
>;
export type NativeResultArtifactReservationInput = Readonly<
  z.input<typeof nativeResultArtifactReservationSchema>
>;
export type NativeResultArtifactProofInput = Readonly<
  z.input<typeof nativeResultArtifactProofSchema>
>;
