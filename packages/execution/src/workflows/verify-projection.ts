import type { PublishedWorkflow } from '@pertexo/database/runs';
import { verifyWorkflowExecutable } from '@pertexo/workflow-engine';

/** The served catalog (node catalog plus engine policies) stored executables run on. */
export type PersistedWorkflowProjectionVerificationOptions = Readonly<{
  catalog: unknown;
}>;

/** Verifies a published version's stored executable against the served catalog. */
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflow,
  options: PersistedWorkflowProjectionVerificationOptions,
) {
  return verifyWorkflowExecutable({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    catalog: options.catalog,
  });
}
