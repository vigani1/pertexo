import {
  PLATFORM_LOCAL_JSON_CALL_RELEASE,
  PLATFORM_LOCAL_JSON_CALL_STAGED,
  type platformExecutableRegistryHistory,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
} from '@pertexo/workflow-engine';

/** Fixed development cohort only; ordinary release composition is unchanged. */
export function composeWorkerWorkflowCompatibilityRelease(
  release: ReturnType<typeof platformExecutableRegistryHistory>[number],
) {
  return [
    PLATFORM_LOCAL_JSON_CALL_RELEASE.fingerprint,
    PLATFORM_LOCAL_JSON_CALL_STAGED.fingerprint,
  ].includes(release.fingerprint)
    ? composeExecutableCompatibilityReleaseV3(release)
    : composeExecutableCompatibilityRelease(release);
}
