import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  AGENT_FIND_ROWS,
  AGENT_STEP,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { literal, node } from '../../support/coordinator/workflows/graph.js';

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
  table: string,
) {
  const graph: WorkflowGraph = {
    settings: { maxRunDurationMs: 90_000 },
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
              config: { table },
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
    name: table,
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
