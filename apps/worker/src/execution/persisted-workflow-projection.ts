import type {
  PublishedWorkflowV2Projection,
  PublishedWorkflowV3Projection,
  PublishedWorkflowExecutableProjection,
} from '@pertexo/database/execution';
import {
  verifyWorkflowExecutableV2,
  verifyWorkflowExecutableV3,
  type CompiledWorkflowExecutableV2,
  type CompiledWorkflowExecutableV3,
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
): CompiledWorkflowExecutableV2;
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowV3Projection,
  options: PersistedWorkflowProjectionVerificationOptions,
): CompiledWorkflowExecutableV3;
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowExecutableProjection,
  options: PersistedWorkflowProjectionVerificationOptions,
): CompiledWorkflowExecutableV2 | CompiledWorkflowExecutableV3;
export function verifyPersistedWorkflowProjection(
  projection: PublishedWorkflowExecutableProjection,
  options: PersistedWorkflowProjectionVerificationOptions,
): CompiledWorkflowExecutableV2 | CompiledWorkflowExecutableV3 {
  const supportedCurrent = projection.currentCompatibilityRelease;
  const admissionDescription = options.releaseSupport?.descriptions.find(
    ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
  );
  let admissionRelease = options.admissionRelease;
  let currentRelease = options.currentRelease;
  if (options.releaseSupport !== undefined) {
    if (supportedCurrent === undefined || admissionDescription === undefined)
      throw new TypeError(
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
  }
  const verify =
    projection.executableSchemaVersion === 3
      ? verifyWorkflowExecutableV3
      : verifyWorkflowExecutableV2;
  const executable = verify({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    admissionRelease,
    ...(currentRelease === undefined ? {} : { currentRelease }),
    execution: { alreadyAdmitted: true },
  });
  if (
    executable.envelope.schemaVersion !== projection.executableSchemaVersion ||
    executable.envelope.sourceGraphSchemaVersion !== projection.schemaVersion
  )
    throw new TypeError(
      'Published workflow format columns do not match its executable envelope',
    );
  if (
    executable.envelope.compatibilityReleaseEpoch !==
    projection.compatibilityReleaseEpoch
  )
    throw new TypeError(
      'Published workflow compatibility release epoch does not match its executable envelope',
    );
  return executable;
}
