import { NodeRegistryCompatibilityError } from './executor-errors.js';
import { identityToken, sameIdentity } from './identity.js';
import type { NodeRegistryOptions } from './executor-contracts.js';
import type { ExecutorIdentity, NodeManifest } from './catalog.js';

/** Bind local schemas and executors to the served node catalog. */
export function bindNodeCatalog(
  options: NodeRegistryOptions,
): NodeRegistryOptions {
  const definitions = new Map(
    options.definitions.map((registration) => [
      identityToken(registration.manifest.definition),
      registration,
    ]),
  );
  const executors = new Map(
    options.executors.map((registration) => [
      identityToken(registration.executor),
      registration,
    ]),
  );
  return Object.freeze({
    catalog: options.catalog,
    definitions: Object.freeze(
      options.catalog.definitions.map((manifest) => {
        const registration = definitions.get(
          identityToken(manifest.definition),
        );
        if (registration === undefined)
          throw new NodeRegistryCompatibilityError(
            `definition ${manifest.definition.key}@${String(manifest.definition.version)} is not implemented`,
          );
        return Object.freeze({ ...registration, manifest });
      }),
    ),
    executors: Object.freeze(
      options.catalog.executors.map((manifest) => {
        const registration = executors.get(identityToken(manifest.executor));
        if (registration === undefined)
          throw new NodeRegistryCompatibilityError(
            `executor ${manifest.executor.key}@${String(manifest.executor.version)} is not implemented`,
          );
        return Object.freeze({ ...manifest, execute: registration.execute });
      }),
    ),
  });
}

export function assertDefinitionExecutorBinding(
  manifest: Pick<NodeManifest, 'definition' | 'executor'>,
  requestedExecutor: ExecutorIdentity,
): void {
  if (!sameIdentity(manifest.executor, requestedExecutor))
    throw new NodeRegistryCompatibilityError(
      `definition ${manifest.definition.key}@${String(manifest.definition.version)} is not bound to executor ${requestedExecutor.key}@${String(requestedExecutor.version)}`,
    );
}
