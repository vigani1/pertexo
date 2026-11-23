import type { NodeManifest } from '../definitions/catalog.js';
import { identityToken, sameIdentity } from '../definitions/identity.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';
import type { CoreNodeExecutorRegistration } from './node-execution.types.js';

export const DISPATCH_AWARE_EXECUTOR_ABI_VERSION = 2 as const;
export const PERTEXO_HOST_RELEASE = '0.2.0';

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
