import { createNodeCatalog, executorManifestFor } from '@pertexo/node-sdk';
import { createInlineNodeRegistry } from '@pertexo/node-sdk/server';
import {
  PLATFORM_NODE_CATALOG,
  resolvePlatformNodeDefinition,
} from '@pertexo/node-catalog';

const original = resolvePlatformNodeDefinition({ key: 'core.set', version: 1 });
export const inlineDefinition = { key: 'core.set', version: 3 };
const manifest = {
  ...original.manifest,
  definition: inlineDefinition,
  executor: inlineDefinition,
  execution: 'inline',
};
const bindings = {
  definitions: [...PLATFORM_NODE_CATALOG.definitions, manifest],
  executors: [
    ...PLATFORM_NODE_CATALOG.executors,
    executorManifestFor(manifest),
  ],
  policies: PLATFORM_NODE_CATALOG.policies,
};
export const inlineFixtureCatalog = createNodeCatalog(bindings);

export function createInlineFixtureRegistry(afterKernel) {
  const executeInline = ({ config, input, now, ...capabilities }) => {
    if (Object.keys(capabilities).length !== 0 || !Number.isFinite(now))
      throw new Error('Inline invocation exposed a host capability');
    if (Object.keys(config).length !== 0)
      throw new Error('Inline config was not parsed');
    const result =
      input.fail === true
        ? {
            kind: 'failed',
            failure: {
              kind: 'failed',
              errorKind: 'configuration',
              safeErrorCode: 'execution.configuration',
            },
          }
        : { kind: 'succeeded', output: { value: input.prior + 1 } };
    afterKernel();
    return result;
  };
  return createInlineNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [manifest],
      executors: [executorManifestFor(manifest)],
      policies: manifest.policyReferences,
    }),
    definitions: [],
    executors: [],
    core: {
      definitions: [{ ...original, manifest }],
      executors: [
        {
          executor: manifest.executor,
          execute: async ({ config, input }) => {
            const result = executeInline({ config, input, now: 0 });
            if (result.kind === 'failed')
              throw new Error('Fixture attempt failed');
            return result.output;
          },
          executeInline,
        },
      ],
    },
  });
}
