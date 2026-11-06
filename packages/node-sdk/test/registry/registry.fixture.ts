import { vi } from 'vitest';
import { z } from 'zod';

import {
  createNodeCatalog,
  generateSchemaDocument,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type NodeManifest,
  type PolicyReference,
} from '../../src/definitions/catalog.js';
import {
  createNodeRegistry,
  type NodeExecutorRegistration,
} from '../../src/server.js';

export const definition: DefinitionIdentity = Object.freeze({
  key: 'test.echo',
  version: 1,
});

export const executor: ExecutorIdentity = Object.freeze({
  key: 'test.echo',
  version: 1,
});

export const policy: PolicyReference = Object.freeze({
  key: 'test.policy',
  version: 1,
});

export const secondPolicy: PolicyReference = Object.freeze({
  key: 'test.policy.second',
  version: 1,
});

export const manifest: NodeManifest = Object.freeze({
  capabilities: Object.freeze(['test']),
  configSchema: generateSchemaDocument(z.object({}).strict()),
  configVersion: 1,
  connectionRequirements: Object.freeze([]),
  credentialRequirements: Object.freeze([]),
  definition,
  family: 'transform',
  inputSchema: generateSchemaDocument(z.record(z.string(), z.json())),
  outputSchema: generateSchemaDocument(z.record(z.string(), z.json())),
  policyReferences: Object.freeze([policy]),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  resourceClass: 'cpu',
  retryClass: 'safe',
  executor,
  executorAbi: 1,
});

export const executorRegistration = (
  identity: ExecutorIdentity = executor,
): NodeExecutorRegistration => ({
  executor: identity,
  execute: () => Promise.resolve({}),
});

export const configSchema = z.object({}).strict();

export const objectSchema = z.record(z.string(), z.json());

export function catalog(): ReturnType<typeof createNodeCatalog> {
  return createNodeCatalog({
    definitions: [manifest],
    executors: [
      {
        abiVersion: 1,
        definitions: [definition],
        executor,
        policyReferences: [policy],
      },
    ],
    policies: [policy],
  });
}

export function dispatchAwareFixture(
  beforeDispatch = vi.fn(() => Promise.resolve()),
) {
  const dispatchManifest = {
    ...manifest,
    executorAbi: 2,
  } satisfies NodeManifest;
  const dispatchCatalog = createNodeCatalog({
    definitions: [dispatchManifest],
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
  const runtime = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    nodeRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    attemptNumber: 1,
    nodeId: 'node-1',
    invocationKey: 'invocation-1',
    sideEffectClass: 'unsafe' as const,
    beforeDispatch,
  };
  const request = {
    config: {},
    definition,
    executor,
    input: {},
    connectionRefs: {
      http_headers: '55555555-5555-4555-8555-555555555555',
    },
    signal: new AbortController().signal,
    runtime,
  };
  const registryFor = (execute: NodeExecutorRegistration['execute']) =>
    createNodeRegistry({
      definitions: [
        {
          manifest: dispatchManifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [
        {
          ...executorRegistration(),
          execute,
        },
      ],
      catalog: dispatchCatalog,
    });
  return { beforeDispatch, registryFor, request, runtime };
}
