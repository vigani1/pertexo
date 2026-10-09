import type { PublishedWorkflowV2Projection } from '@pertexo/database/runs';
import { verifyWorkflowExecutable } from '@pertexo/workflow-engine';

/** The release (node catalog plus engine policies) stored executables run on. */
export type PersistedWorkflowProjectionVerificationOptions = Readonly<{
  release: unknown;
}>;

/** Verifies a published version's stored executable against the served release. */
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowV2Projection,
  options: PersistedWorkflowProjectionVerificationOptions,
) {
  return verifyWorkflowExecutable({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    release: options.release,
  });
}
