import { NodeRegistryCompatibilityError } from './executor-errors.js';
import { sameIdentity } from './identity.js';
import type { ExecutorIdentity, NodeManifest } from './release.js';

export function assertDefinitionExecutorBinding(
  manifest: Pick<NodeManifest, 'definition' | 'executor'>,
  requestedExecutor: ExecutorIdentity,
): void {
  if (!sameIdentity(manifest.executor, requestedExecutor))
    throw new NodeRegistryCompatibilityError(
      `definition ${manifest.definition.key}@${String(manifest.definition.version)} is not bound to executor ${requestedExecutor.key}@${String(requestedExecutor.version)}`,
    );
}
