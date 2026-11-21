import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { CORE_INLINE_DEFINITION_VERSION } from '@pertexo/workflow-model';

function inlineCoreManifest(manifest: NodeDefinitionRegistration['manifest']) {
  return Object.freeze({
    ...manifest,
    definition: Object.freeze({
      key: manifest.definition.key,
      version: CORE_INLINE_DEFINITION_VERSION,
    }),
    executor: Object.freeze({
      key: manifest.executor.key,
      version: CORE_INLINE_DEFINITION_VERSION,
    }),
    execution: 'inline' as const,
  });
}

export function withInlineVersion(registration: NodeDefinitionRegistration) {
  return [
    Object.freeze(registration),
    Object.freeze({
      ...registration,
      manifest: inlineCoreManifest(registration.manifest),
    }),
  ] as const;
}
