import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  AGENT_FIND_ROWS,
  AGENT_INSERT_ROW,
  AGENT_SEND_SLACK_MESSAGE,
  AGENT_SLACK_CONNECTION_SLOT,
  AGENT_STEP,
  PENDING_TASK_LIMITS,
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
export const slackChannel = 'CAGENTTEST';
export const slackBotToken = 'xoxb-agent-synthetic-test';

export async function publishAgent(
  authoring: ReturnType<typeof createWorkflowAuthoringStore>,
  connectionId: string,
  table: string,
  write?: 'approval' | 'allow' | { slackConnectionId: string },
) {
  const expiry = PENDING_TASK_LIMITS.minimumExpirySeconds;
  const slack = typeof write === 'object' ? write : undefined;
  let definition: WorkflowGraph['nodes'][number]['definition'] =
    AGENT_FIND_ROWS;
  let description = 'Look up one workspace order';
  if (slack !== undefined) {
    definition = AGENT_SEND_SLACK_MESSAGE;
    description = 'Send an update to the selected Slack channel';
  } else if (write !== undefined) {
    definition = AGENT_INSERT_ROW;
    description = 'Insert a workspace order';
  }
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
            ...(write === 'approval'
              ? { timeoutMillis: (expiry + 1) * 1_000 }
              : {}),
            tool: {
              alias,
              description,
              definition,
              config:
                slack === undefined
                  ? { table }
                  : { channelId: slackChannel, timeoutMillis: 10_000 },
              ...(write === undefined
                ? {}
                : {
                    writePermission:
                      write !== 'approval'
                        ? { kind: 'allow' }
                        : {
                            kind: 'approval',
                            config: {
                              title: 'Approve order',
                              instructions: '',
                              expiresAfterSeconds: expiry,
                              audience: {
                                roles: [],
                                memberIds: [actor.actorId],
                              },
                              allowStarterToDecide: true,
                            },
                          },
                  }),
            },
          },
        ),
        connectionRefs: {
          model_api_key: connectionId,
          ...(slack === undefined
            ? {}
            : { [AGENT_SLACK_CONNECTION_SLOT]: slack.slackConnectionId }),
        },
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
