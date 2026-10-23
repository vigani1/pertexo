import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createNodeCatalog,
  generateSchemaDocument,
  type NodeManifest,
  TERMINATES_RUN_CAPABILITY,
} from '../../src/definitions/catalog.js';
import {
  NodeConfigValidationError,
  NodeExecutionAbortedError,
  NodeInputValidationError,
  NodeOutputValidationError,
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
  dispatchAwareFixture,
} from '../support/registry.js';

describe('node-sdk exact server registry', () => {
  it('derives terminal success from the pinned capability', async () => {
    const terminalManifest = {
      ...manifest,
      capabilities: [TERMINATES_RUN_CAPABILITY],
    } satisfies NodeManifest;
    const terminalCatalog = createNodeCatalog({
      definitions: [terminalManifest],
      executors: catalog().executors,
      policies: [policy],
    });
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest: terminalManifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      catalog: terminalCatalog,
    });
    await expect(
      registry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'terminal_success' });
  });

  it('rejects cancellation before execution and preserves confirmed success', async () => {
    const before = new AbortController();
    before.abort();
    const normal = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      catalog: catalog(),
    });
    await expect(
      normal.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: before.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);

    const after = new AbortController();
    const aborting = {
      ...executorRegistration(),
      execute: () => {
        after.abort();
        return Promise.resolve({});
      },
    };
    const abortingRegistry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [aborting],
      catalog: catalog(),
    });
    await expect(
      abortingRegistry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: after.signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: {} });
  });

  it('maps config, input, and output schema failures to stable errors', async () => {
    const schemas = {
      configSchema: z.object({ required: z.string() }).strict(),
      inputSchema: z.object({ required: z.string() }).strict(),
      outputSchema: z.object({ required: z.string() }).strict(),
    };
    const strictManifest = {
      ...manifest,
      configSchema: generateSchemaDocument(schemas.configSchema),
      inputSchema: generateSchemaDocument(schemas.inputSchema),
      outputSchema: generateSchemaDocument(schemas.outputSchema),
    } satisfies NodeManifest;
    const strictCatalog = createNodeCatalog({
      definitions: [strictManifest],
      executors: catalog().executors,
      policies: [policy],
    });
    const strictRegistry = createNodeRegistry({
      definitions: [{ manifest: strictManifest, ...schemas }],
      executors: [executorRegistration()],
      catalog: strictCatalog,
    });
    const request = {
      definition,
      executor,
      signal: new AbortController().signal,
    };
    await expect(
      strictRegistry.execute({
        ...request,
        config: {},
        input: { required: 'x' },
      }),
    ).rejects.toBeInstanceOf(NodeConfigValidationError);
    await expect(
      strictRegistry.execute({
        ...request,
        config: { required: 'x' },
        input: {},
      }),
    ).rejects.toBeInstanceOf(NodeInputValidationError);
    await expect(
      strictRegistry.execute({
        ...request,
        config: { required: 'x' },
        input: { required: 'x' },
      }),
    ).rejects.toBeInstanceOf(NodeOutputValidationError);
  });
});

describe('artifact read capability grants', () => {
  it.each([false, true])(
    'exposes artifact reads only to a consuming manifest (%s)',
    async (allowed) => {
      const fixture = dispatchAwareFixture();
      const selected = {
        ...manifest,
        capabilities: allowed ? ['artifact_input'] : [],
        executorAbi: 2,
      };
      const sourceCatalog = createNodeCatalog({
        definitions: [selected],
        executors: [
          {
            abiVersion: 2,
            definitions: [definition],
            executor,
            policyReferences: [policy],
          },
        ],
        policies: [policy],
      });
      const read = vi.fn().mockResolvedValue(new Uint8Array());
      const write = vi.fn().mockResolvedValue({
        artifactId: '11111111-1111-4111-8111-111111111111',
        byteLength: 0,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      });
      let actual: unknown;
      const registry = createNodeRegistry({
        catalog: sourceCatalog,
        definitions: [
          {
            manifest: selected,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [
          {
            executor,
            execute: async (invocation) => {
              actual = await invocation.runtime?.artifacts?.read?.({
                reference: {
                  artifactId: '11111111-1111-4111-8111-111111111111',
                  byteLength: 0,
                  mediaType: 'application/octet-stream',
                  sha256: 'a'.repeat(64),
                },
                maxBytes: 1,
                signal: invocation.signal,
              });
              await invocation.runtime?.beforeDispatch();
              return {};
            },
          },
        ],
      });
      await registry.execute({
        ...fixture.request,
        runtime: { ...fixture.request.runtime, artifacts: { read, write } },
      });
      expect(actual).toEqual(allowed ? new Uint8Array() : undefined);
      expect(read).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
});
