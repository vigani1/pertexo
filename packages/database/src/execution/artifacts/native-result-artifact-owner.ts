import type { Pool } from 'pg';
import {
  nativeResultArtifactReservationSchema,
  nativeResultArtifactProofSchema,
  type NativeResultArtifactReservationInput,
  type NativeResultArtifactProofInput,
} from './native-result-artifact-contract.js';
import type { NativeAttemptArtifactMetadata } from './native-attempt-artifact-contract.js';
import {
  reserveNativeArtifactCandidate,
  inspectNativeArtifactCandidate,
} from './native-artifact-candidate-owner.js';

/** Fresh current result producer; no acceptance or second quota owner. */
export async function reserveNativeResultArtifact(
  pool: Pool,
  request: NativeResultArtifactReservationInput,
): Promise<NativeAttemptArtifactMetadata> {
  return reserveNativeArtifactCandidate(
    pool,
    nativeResultArtifactReservationSchema.parse(request),
  );
}

export async function inspectNativeResultArtifact(
  pool: Pool,
  request: NativeResultArtifactProofInput,
  finalize = false,
): Promise<void> {
  return inspectNativeArtifactCandidate(
    pool,
    nativeResultArtifactProofSchema.parse(request),
    finalize,
  );
}
