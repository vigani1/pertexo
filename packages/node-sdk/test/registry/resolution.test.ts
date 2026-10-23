import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createNodeCatalog,
  type NodeManifest,
} from '../../src/definitions/catalog.js';
import {
  DefinitionNotFoundError,
  ExecutorNotFoundError,
  InvalidBoundedJsonError,
  NodeExecutionAbortedError,
  NodeRegistryCompatibilityError,
  NODE_EXECUTION_LIMITS,
  createNodeRegistry,
} from '../../src/server.js';
import {
  definition,
  executor,
  policy,
  manifest,
  executorRegistration,
  configSchema,
  objectSchema,
  catalog,
} from '../support/registry.js';

describe('node-sdk exact server registry', () => {
  it('rejects duplicate identities and mismatched bindings', () => {
    const one = catalog();
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
          {
            manifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        catalog: one,
      }),
    ).toThrow(NodeRegistryCompatibilityError);
  });

  it('rejects runtime schemas that drift from their published documents', () => {
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest,
            configSchema: z.string(),
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        catalog: catalog(),
      }),
    ).toThrow(/JSON Schema projection/u);
  });

  it('keeps registrations private, snapshots metadata, and enforces aggregate input bounds', async () => {
    const registration = executorRegistration();
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [registration],
      catalog: catalog(),
    });
    expect(Object.keys(registry).sort()).toEqual(['dispatchMode', 'execute']);
    const half = 'x'.repeat(Math.ceil(NODE_EXECUTION_LIMITS.bytes / 2));
    await expect(
      registry.execute({
        config: { value: half },
        definition,
        executor,
        input: { value: half },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(InvalidBoundedJsonError);
  });

  it('resolves the exact executor and never falls forward to another version', async () => {
    const one = catalog();
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      catalog: one,
    });

    await expect(
      registry.execute({
        config: {},
        definition,
        executor: { key: executor.key, version: 2 },
        input: { value: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ExecutorNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: { key: definition.key, version: 2 },
        executor,
        input: { value: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DefinitionNotFoundError);
  });

  it('preserves definition and executor resolution order across registry entrypoints', async () => {
    const otherDefinition = { key: 'test.other', version: 1 } as const;
    const otherExecutor = { key: 'test.other', version: 1 } as const;
    const otherManifest = {
      ...manifest,
      definition: otherDefinition,
      executor: otherExecutor,
    } satisfies NodeManifest;
    const [baseExecutor] = catalog().executors;
    if (baseExecutor === undefined)
      throw new Error('test release is missing its executor');
    const exactCatalog = createNodeCatalog({
      definitions: [manifest, otherManifest],
      executors: [
        baseExecutor,
        {
          abiVersion: 1,
          definitions: [otherDefinition],
          executor: otherExecutor,
          policyReferences: [policy],
        },
      ],
      policies: [policy],
    });
    const registry = createNodeRegistry({
      definitions: [manifest, otherManifest].map((item) => ({
        manifest: item,
        configSchema,
        inputSchema: objectSchema,
        outputSchema: objectSchema,
      })),
      executors: [executorRegistration(), executorRegistration(otherExecutor)],
      catalog: exactCatalog,
    });
    const missingDefinition = { key: definition.key, version: 2 } as const;
    const missingExecutor = { key: executor.key, version: 2 } as const;

    expect(() =>
      registry.dispatchMode({
        definition: missingDefinition,
        executor: missingExecutor,
      }),
    ).toThrow(ExecutorNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor: missingExecutor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ExecutorNotFoundError);

    expect(() =>
      registry.dispatchMode({ definition: missingDefinition, executor }),
    ).toThrow(DefinitionNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DefinitionNotFoundError);

    const bindingError =
      'definition test.echo@1 is not bound to executor test.other@1';
    expect(() =>
      registry.dispatchMode({ definition, executor: otherExecutor }),
    ).toThrow(bindingError);
    await expect(
      registry.execute({
        config: {},
        definition,
        executor: otherExecutor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(bindingError);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor: missingExecutor,
        input: {},
        signal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);
    expect(registry.dispatchMode({ definition, executor })).toBe(
      'before_execute',
    );
    await expect(
      registry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: {} });
  });
});
