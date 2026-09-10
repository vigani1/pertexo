import type { PublishedWorkflowV2Projection } from '@pertexo/database/execution';
import {
  verifyWorkflowExecutableV2,
  type ExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

export type PersistedWorkflowProjectionVerificationOptions = Readonly<{
  admissionRelease: unknown;
  currentRelease?: unknown;
  releaseSupport?: ExecutableCompatibilityReleaseSupport;
}>;

/** Verify a projection against its exact admission and current releases. */
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowV2Projection,
  options: PersistedWorkflowProjectionVerificationOptions,
) {
  const supportedCurrent = projection.currentCompatibilityRelease;
  const admissionDescription = options.releaseSupport?.descriptions.find(
    ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
  );
  if (
    options.releaseSupport !== undefined &&
    (supportedCurrent === undefined || admissionDescription === undefined)
  )
    throw new TypeError('Published workflow compatibility release is missing');
  const admissionRelease =
    options.releaseSupport === undefined
      ? options.admissionRelease
      : options.releaseSupport.resolve(
          admissionDescription?.epoch ?? 0,
          admissionDescription?.fingerprint ?? '',
        );
  const currentRelease =
    options.releaseSupport === undefined
      ? options.currentRelease
      : options.releaseSupport.resolve(
          supportedCurrent?.epoch ?? 0,
          supportedCurrent?.fingerprint ?? '',
        );
  const executable = verifyWorkflowExecutableV2({
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
    throw new TypeError(
      'Published workflow compatibility release epoch does not match its executable envelope',
    );
  return executable;
}
