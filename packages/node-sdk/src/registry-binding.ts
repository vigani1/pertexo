import { NodeRegistryCompatibilityError } from './executor-errors.js';
import { sameIdentity } from './identity.js';
import type {
  DefinitionIdentity,
  ExecutorIdentity,
} from './release.js';

export function assertDefinitionExecutorBinding(
  definition: DefinitionIdentity,
  boundExecutor: ExecutorIdentity,
  requestedExecutor: ExecutorIdentity,
): void {
  if (!sameIdentity(boundExecutor, requestedExecutor))
    throw new NodeRegistryCompatibilityError(
      `definition ${definition.key}@${String(definition.version)} is not bound to executor ${requestedExecutor.key}@${String(requestedExecutor.version)}`,
    );
}
