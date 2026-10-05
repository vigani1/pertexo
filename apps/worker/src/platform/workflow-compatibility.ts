import {
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED,
  type platformExecutableRegistryHistory,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
} from '@pertexo/workflow-engine';

/** Native successors use V3 composition; retained identities stay unchanged. */
export function composeWorkerWorkflowCompatibilityRelease(
  release: ReturnType<typeof platformExecutableRegistryHistory>[number],
) {
  return [
    PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE.fingerprint,
    PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED.fingerprint,
  ].includes(release.fingerprint)
    ? composeExecutableCompatibilityReleaseV3(release)
    : composeExecutableCompatibilityRelease(release);
}
