import type { PublishedWorkflowV2Projection } from '@pertexo/database/runs';
import {
  verifyWorkflowExecutable,
  WorkflowEngineError,
  type ExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

/**
 * Releases to verify against: the supported release history (production), or
 * explicit releases.
 */
export type PersistedWorkflowProjectionVerificationOptions =
  | Readonly<{ releaseSupport: ExecutableCompatibilityReleaseSupport }>
  | Readonly<{ admissionRelease: unknown; currentRelease?: unknown }>;

/** Verify a projection against its exact admission and current releases. */
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowV2Projection,
  options: PersistedWorkflowProjectionVerificationOptions,
) {
  let admissionRelease: unknown;
  let currentRelease: unknown;
  if ('releaseSupport' in options) {
    const supportedCurrent = projection.currentCompatibilityRelease;
    const admissionDescription = options.releaseSupport.descriptions.find(
      ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
    );
    if (supportedCurrent === undefined || admissionDescription === undefined)
      throw new WorkflowEngineError(
        'executable_invalid',
        'Published workflow compatibility release is missing',
      );
    admissionRelease = options.releaseSupport.resolve(
      admissionDescription.epoch,
      admissionDescription.fingerprint,
    );
    currentRelease = options.releaseSupport.resolve(
      supportedCurrent.epoch,
      supportedCurrent.fingerprint,
    );
  } else {
    admissionRelease = options.admissionRelease;
    currentRelease = options.currentRelease;
  }
  const executable = verifyWorkflowExecutable({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    admissionRelease,
    ...(currentRelease === undefined ? {} : { currentRelease }),
    execution: { alreadyAdmitted: true },
  });
  if (
    executable.envelope.compatibilityReleaseEpoch !==
    projection.compatibilityReleaseEpoch
  )
    throw new WorkflowEngineError(
      'executable_invalid',
      'Published workflow compatibility release epoch does not match its executable envelope',
    );
  return executable;
}
