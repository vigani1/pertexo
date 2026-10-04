import type { Pool } from 'pg';
import {
  nativeAttemptArtifactReservationSchema,
  nativeAttemptArtifactProofSchema,
  type NativeAttemptArtifactReservationInput,
  type NativeAttemptArtifactProofInput,
  type NativeAttemptArtifactMetadata,
} from './native-attempt-artifact-contract.js';
import {
  reserveNativeArtifactCandidate,
  inspectNativeArtifactCandidate,
} from './native-artifact-candidate-owner.js';

/** Existing attempt producer boundary; shared lifecycle mechanics, same SQL authority. */
export async function reserveNativeAttemptArtifact(
  pool: Pool,
  request: NativeAttemptArtifactReservationInput,
): Promise<NativeAttemptArtifactMetadata> {
  return reserveNativeArtifactCandidate(
    pool,
    nativeAttemptArtifactReservationSchema.parse(request),
  );
}

export async function inspectNativeAttemptArtifact(
  pool: Pool,
  request: NativeAttemptArtifactProofInput,
  finalize = false,
): Promise<void> {
  return inspectNativeArtifactCandidate(
    pool,
    nativeAttemptArtifactProofSchema.parse(request),
    finalize,
  );
}
