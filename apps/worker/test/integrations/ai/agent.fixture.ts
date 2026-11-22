import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  INTEGRATION_MODULES,
  type IntegrationModule,
} from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createNodeCatalog, executorManifestFor } from '@pertexo/node-sdk';
import { createNodeRegistry } from '@pertexo/node-sdk/server';
import type { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import {
  AGENT_FIND_ROWS,
  AGENT_STEP,
  isAgentDefinition,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';

import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { literal, node } from '../../support/coordinator/workflows/graph.js';

const agentStep = INTEGRATION_MODULES.flatMap(
  (module: IntegrationModule) => module.steps,
).find(({ registration: { manifest } }) =>
  isAgentDefinition(manifest.definition),
);
if (agentStep === undefined)
  throw new Error('Agent integration step is missing');
const { registration, createExecutor } = agentStep;
export const catalog = createNodeCatalog({
  definitions: [...PLATFORM_NODE_CATALOG.definitions, registration.manifest],
  executors: [
    ...PLATFORM_NODE_CATALOG.executors,
    executorManifestFor(registration.manifest),
  ],
  policies: PLATFORM_NODE_CATALOG.policies,
});
export const executableCatalog = composeExecutableCatalog(catalog);
export const actor = {
  workspaceId: fixture.workspaceId,
  actorId: fixture.actorId,
};
export const config = (url: string) =>
  parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max: 6 });
export const commandKey = () =>
  createHash('sha256').update(randomUUID()).digest('hex');
export const alias = 'find_order';
export const model = 'fake-agent';

export async function publishAgent(
  authoring: ReturnType<typeof createWorkflowAuthoringStore>,
  connectionId: string,
) {
  const graph: WorkflowGraph = {
    settings: { maxRunDurationMs: 30_000 },
    callable: {
      input: { type: 'object', properties: [] },
      resultType: {
        type: 'object',
        properties: [
          { name: 'text', valueType: { type: 'string' }, required: true },
        ],
      },
      result: { kind: 'node_output', nodeId: 'agent', path: '$' },
    },
    nodes: [
      node('start', 'core.manual'),
      {
        ...node(
          'agent',
          AGENT_STEP.key,
          { prompt: literal('Find order a.') },
          {
            model,
            tool: {
              alias,
              description: 'Look up one workspace order',
              definition: AGENT_FIND_ROWS,
              config: { table: 'Agent Orders' },
            },
          },
        ),
        connectionRefs: { model_api_key: connectionId },
      },
    ],
    edges: [
      {
        id: 'start-agent',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'agent', port: 'in' },
      },
    ],
  };
  const { workflowId } = await authoring.createWorkflow({
    ...actor,
    name: 'Agent read-tool integration',
    emptyGraph: graph,
    idempotencyKey: randomUUID(),
  });
  const draft = await authoring.getDraft(
    actor.workspaceId,
    workflowId,
    actor.actorId,
  );
  if (draft === null) throw new Error('Agent draft is missing');
  const published = await authoring.publishWorkflow({
    ...actor,
    workflowId,
    idempotencyKey: randomUUID(),
    requestHash: commandKey(),
    representationTag: workflowDraftRepresentationTag({
      workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
  });
  expect(published.version.graphJson.nodes[1]?.config).toEqual(
    graph.nodes[1]?.config,
  );
  return workflowId;
}

export function agentRegistry(
  allowedPrivateNetworks: ReturnType<typeof parseAllowedPrivateNetworks>,
) {
  const httpClient = createNodeProviderHttpClient({ allowedPrivateNetworks });
  const platform = createPlatformNodeRegistry({ httpClient });
  const agent = createNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [registration.manifest],
      executors: [executorManifestFor(registration.manifest)],
      policies: [],
    }),
    definitions: [registration],
    executors: [
      createExecutor({
        httpClient,
        fixedEndpointHttpClient: httpClient,
      }),
    ],
  });
  return {
    dispatchMode: (request: Parameters<typeof platform.dispatchMode>[0]) =>
      (isAgentDefinition(request.definition) ? agent : platform).dispatchMode(
        request,
      ),
    execute: (request: Parameters<typeof platform.execute>[0]) =>
      (isAgentDefinition(request.definition) ? agent : platform).execute(
        request,
      ),
  };
}
