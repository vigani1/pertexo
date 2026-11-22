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
  CORE_INLINE_DEFINITION_VERSION,
  PENDING_TASK_LIMITS,
  WORKFLOW_CALL,
  type CallableType,
  type WorkflowCallPin,
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

export type AgentCallable = Readonly<{
  target: WorkflowCallPin;
  input: CallableType;
  approval?: boolean;
  timeoutMillis?: number;
}>;

export async function publishAgent(
  authoring: ReturnType<typeof createWorkflowAuthoringStore>,
  connectionId: string,
  table: string,
  {
    write,
    shape,
  }: Readonly<{
    write?:
      | 'approval'
      | 'allow'
      | { slackConnectionId: string }
      | AgentCallable
      | undefined;
    shape?: 'linear-sets' | 'sibling-set' | undefined;
  }>,
) {
  const expiry = PENDING_TASK_LIMITS.minimumExpirySeconds;
  const slack =
    typeof write === 'object' && 'slackConnectionId' in write
      ? write
      : undefined;
  const callable =
    typeof write === 'object' && 'target' in write ? write : undefined;
  const approval = write === 'approval' || callable?.approval === true;
  let definition: WorkflowGraph['nodes'][number]['definition'] =
    AGENT_FIND_ROWS;
  let description = 'Look up one workspace order';
  if (slack !== undefined) {
    definition = AGENT_SEND_SLACK_MESSAGE;
    description = 'Send an update to the selected Slack channel';
  } else if (callable !== undefined) {
    definition = WORKFLOW_CALL;
    description = 'Find the order in a published workflow';
  } else if (write !== undefined) {
    definition = AGENT_INSERT_ROW;
    description = 'Insert a workspace order';
  }
  const timeoutMillis =
    callable?.timeoutMillis ?? (approval ? (expiry + 1) * 1_000 : undefined);
  let toolConfig: WorkflowGraph['nodes'][number]['config'] = { table };
  if (callable !== undefined)
    toolConfig = { target: { ...callable.target }, input: callable.input };
  else if (slack !== undefined)
    toolConfig = { channelId: slackChannel, timeoutMillis: 10_000 };
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
            ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
            tool: {
              alias,
              description,
              definition,
              config: toolConfig,
              ...toolPermission(write, approval, expiry),
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
  const shapes = {
    'linear-sets': surroundAgentWithSets,
    'sibling-set': addAgentSiblingSet,
  };
  const published = await publishAgentFixtureGraph(
    authoring,
    shape === undefined ? graph : shapes[shape](graph),
    table,
  );
  expect(published.version.graphJson.nodes[1]?.config).toEqual(
    graph.nodes[1]?.config,
  );
  return published.version.workflowId;
}

function surroundAgentWithSets(graph: WorkflowGraph): WorkflowGraph {
  const output = (nodeId: string, path: string) =>
    ({ kind: 'node_output', nodeId, path }) as const;
  const edges = [
    ['start', 'before-agent'],
    ['before-agent', 'agent'],
    ['agent', 'after-agent'],
    ['after-agent', 'end'],
  ] as const;
  const { callable } = graph;
  return {
    ...graph,
    ...(callable === undefined
      ? {}
      : { callable: { ...callable, result: output('after-agent', '$') } }),
    nodes: [
      ...graph.nodes.map((step) =>
        step.id === 'agent'
          ? {
              ...step,
              inputMappings: { prompt: output('before-agent', '$.prompt') },
            }
          : step,
      ),
      inlineSet('before-agent', { prompt: literal('Find order a.') }),
      inlineSet('after-agent', { text: output('agent', '$.text') }),
      node('end', 'core.terminate', { result: output('after-agent', '$') }),
    ],
    edges: edges.map(([source, target]) => ({
      id: `mixed-${target}`,
      source: { nodeId: source, port: 'out' },
      target: { nodeId: target, port: 'in' },
    })),
  };
}

function addAgentSiblingSet(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: [...graph.nodes, inlineSet('sibling', { value: literal('ready') })],
    edges: [
      ...graph.edges,
      {
        id: 'start-sibling',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'sibling', port: 'in' },
      },
    ],
  };
}

function inlineSet(
  id: string,
  inputMappings: WorkflowGraph['nodes'][number]['inputMappings'],
) {
  return {
    ...node(id, 'core.set', inputMappings),
    definition: { key: 'core.set', version: CORE_INLINE_DEFINITION_VERSION },
  };
}

function toolPermission(
  write: unknown,
  approval: boolean,
  expiresAfterSeconds: number,
) {
  if (write === undefined) return {};
  if (!approval) return { writePermission: { kind: 'allow' } };
  return {
    writePermission: {
      kind: 'approval',
      config: {
        title: 'Approve order',
        instructions: '',
        expiresAfterSeconds,
        audience: { roles: [], memberIds: [actor.actorId] },
        allowStarterToDecide: true,
      },
    },
  };
}

export async function publishAgentFixtureGraph(
  authoring: ReturnType<typeof createWorkflowAuthoringStore>,
  graph: WorkflowGraph,
  name: string,
) {
  const { workflowId } = await authoring.createWorkflow({
    ...actor,
    name,
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
  return published;
}
