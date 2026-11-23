import type { NodeManifest } from '../definitions/catalog.js';
import { identityToken, sameIdentity } from '../definitions/identity.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';
import type { CoreNodeExecutorRegistration } from './node-execution.types.js';

export const DISPATCH_AWARE_EXECUTOR_ABI_VERSION = 2 as const;
export const PERTEXO_HOST_RELEASE = '0.2.0';

const SEMVER_CORE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function hostReleaseCompatibility(
  range: Readonly<{ min: string; below: string }>,
  release: string = PERTEXO_HOST_RELEASE,
): 'invalid' | 'compatible' | 'incompatible' {
  const { min, below } = range;
  if (
    ![min, below, release].every((version) => SEMVER_CORE.test(version)) ||
    compareRelease(min, below) >= 0
  )
    return 'invalid';
  return compareRelease(min, release) <= 0 && compareRelease(release, below) < 0
    ? 'compatible'
    : 'incompatible';
}

function compareRelease(left: string, right: string): number {
  const rightParts = right.split('.');
  for (const [index, part] of left.split('.').entries()) {
    const other = rightParts[index] ?? '';
    // Compare the decimal text to preserve precision for every SemVer core.
    if (part.length !== other.length) return part.length - other.length;
    if (part !== other) return part < other ? -1 : 1;
  }
  return 0;
}

export function validateInlineFallback(
  manifest: NodeManifest,
  coreExecutors: readonly CoreNodeExecutorRegistration[] = [],
): void {
  if (manifest.execution !== 'inline') return;
  const definition = identityToken(manifest.definition);
  if (
    manifest.retryClass !== 'safe' ||
    manifest.credentialRequirements.length > 0 ||
    manifest.connectionRequirements.length > 0 ||
    manifest.capabilities.length > 0
  )
    throw new NodeRegistryCompatibilityError(
      `inline definition ${definition} requires safe retries and zero credential requirements, connection slots or capabilities`,
    );
  if (manifest.executorAbi === DISPATCH_AWARE_EXECUTOR_ABI_VERSION)
    throw new NodeRegistryCompatibilityError(
      `inline definition ${definition} cannot bind a dispatch-aware executor`,
    );
  const binding = coreExecutors.find(({ executor }) =>
    sameIdentity(executor, manifest.executor),
  );
  if (binding === undefined)
    throw new NodeRegistryCompatibilityError(
      `inline definition ${definition} has no core attempt fallback`,
    );
  if (binding.executeInline === undefined)
    throw new NodeRegistryCompatibilityError(
      `inline definition ${definition} has no synchronous core executor`,
    );
}
