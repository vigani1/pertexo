import type { NodeManifest } from '../definitions/catalog.js';
import { identityToken, sameIdentity } from '../definitions/identity.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';
import type { NodeExecutorRegistration } from './node-execution.types.js';

export const DISPATCH_AWARE_EXECUTOR_ABI_VERSION = 2 as const;

export function validateInlineFallback(
  manifest: NodeManifest,
  coreExecutors: readonly NodeExecutorRegistration[] = [],
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
  if (
    !coreExecutors.some(({ executor }) =>
      sameIdentity(executor, manifest.executor),
    )
  )
    throw new NodeRegistryCompatibilityError(
      `inline definition ${definition} has no core attempt fallback`,
    );
}
