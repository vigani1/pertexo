import { randomUUID } from 'node:crypto';
import { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import { createConnectionStore } from '@pertexo/core/connections';
import { createDataTablesStore } from '@pertexo/core/data-tables';
import {
  createWorkflowRunDatabase,
  initialCheckpointFactory,
} from '@pertexo/core/runs';
import type { ConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import { buildWorkflowExecutable } from '@pertexo/workflow-engine/server';
import type {
  SecretConnectionAuthType,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/server';

import { sealAndZero } from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { edge, node } from '../../runs/calls/calls.fixture.js';
import { API_KEY } from './model.fixture.js';
import { catalog, executableCatalog } from './agent-registry.fixture.js';
import {
  actor,
  commandKey,
  config,
  publishAgent,
  publishAgentFixtureGraph,
  slackBotToken,
  slackChannel,
} from './agent.fixture.js';

export async function startAgentRun(
  ...input: Parameters<typeof publishAgentRun>
) {
  return startPublishedAgentRun(await publishAgentRun(...input));
}

export async function publishAgentRun(
  baseUrl: string,
  encryption: ConnectionEnvelopeEncryption,
  write?:
    | 'approval'
    | 'allow'
    | 'slack'
    | {
        child: WorkflowGraph;
        approval?: boolean;
        timeoutMillis?: number;
        childSlackText?: string;
      },
  {
    shape,
    legacy = false,
  }: Readonly<{
    shape?: Parameters<typeof publishAgent>[3]['shape'];
    legacy?: boolean;
  }> = {},
) {
  const connectionId = randomUUID();
  const tableName = `Agent Orders ${connectionId.slice(0, 8)}`;
  const validator = new WorkflowAuthoringValidator();
  const authoring = createWorkflowAuthoringStore(config(fixture.apiUrl), {
    definitionCatalog: {
      definitions: catalog.definitions.map(({ definition }) => definition),
    },
    validateAuthoringGraph: (graph, options) =>
      validator.validate(
        graph,
        {
          definitions: catalog.definitions.map(
            ({ definition, capabilities, policyReferences }) => ({
              definition,
              capabilities,
              policyReferences,
            }),
          ),
        },
        options,
      ),
    executableCompiler: (graph) => {
      const compiled = buildWorkflowExecutable({
        graph,
        catalog: executableCatalog,
      });
      return { checksum: compiled.checksum, executableJson: compiled.envelope };
    },
  });
  const tables = createDataTablesStore(config(fixture.apiUrl));
  const connections = createConnectionStore(config(fixture.apiUrl));
  const owners = [
    () => validator.shutdown(),
    authoring.close,
    tables.close,
    connections.close,
  ];
  try {
    let expectedTableId: string | undefined;
    if (typeof write !== 'object') {
      const table = await tables.create({
        ...actor,
        idempotencyKey: randomUUID(),
        name: tableName,
        columns: [
          { name: 'key', type: 'text', required: true },
          { name: 'amount', type: 'number', required: true },
        ],
        keyColumn: 'key',
      });
      if (write === undefined && !legacy) expectedTableId = table.id;
      await tables.importRows({
        ...actor,
        idempotencyKey: randomUUID(),
        tableId: table.id,
        rows: [
          { key: 'a', amount: 42 },
          { key: 'b', amount: 99 },
        ],
      });
    }
    const secretVersionId = randomUUID();
    const sealed = await sealAndZero(
      encryption,
      Buffer.from(
        JSON.stringify({
          type: 'model_api_key',
          endpoint: 'vllm',
          baseUrl: baseUrl,
          apiKey: API_KEY,
        }),
      ),
      {
        workspaceId: actor.workspaceId,
        connectionId,
        secretVersionId,
      },
    );
    await connections.createConnection({
      ...actor,
      connectionId,
      secretVersionId,
      providerKey: 'ai',
      authType: 'model_api_key' as SecretConnectionAuthType,
      name: tableName,
      sealed,
      idempotencyKey: randomUUID(),
      requestHash: commandKey(),
    });
    let tool: Parameters<typeof publishAgent>[3]['write'];
    if (write === 'slack')
      tool = {
        slackConnectionId: await createSlackConnection(
          connections,
          encryption,
          tableName,
        ),
      };
    else if (typeof write === 'object') {
      const { childSlackText, child, ...settings } = write;
      tool = await publishCallableTool(authoring, tableName, {
        ...settings,
        child:
          childSlackText === undefined
            ? child
            : withChildSlackWrite(
                child,
                childSlackText,
                await createSlackConnection(connections, encryption, tableName),
              ),
      });
    } else tool = write;
    return await publishAgent(authoring, connectionId, tableName, {
      write: tool,
      shape,
      expectedTableId,
    });
  } finally {
    await Promise.allSettled(owners.reverse().map((close) => close()));
  }
}

export async function startPublishedAgentRun(workflowId: string) {
  const runs = createWorkflowRunDatabase(config(fixture.apiUrl));
  try {
    const key = commandKey();
    const accepted = await runs.start({
      ...actor,
      workflowId,
      idempotencyKeyHash: key,
      requestHash: key,
      scope: `workflow:${workflowId}:manual`,
      input: {},
      checkpointFactory: initialCheckpointFactory({
        catalog: executableCatalog,
      }),
    });
    return accepted.run.id;
  } finally {
    await runs.close();
  }
}

async function createSlackConnection(
  connections: ReturnType<typeof createConnectionStore>,
  encryption: ConnectionEnvelopeEncryption,
  tableName: string,
) {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  const sealed = await sealAndZero(
    encryption,
    Buffer.from(
      JSON.stringify({ type: 'slack_bot_token', botToken: slackBotToken }),
    ),
    { workspaceId: actor.workspaceId, connectionId, secretVersionId },
  );
  await connections.createConnection({
    ...actor,
    connectionId,
    secretVersionId,
    providerKey: 'slack',
    authType: 'slack_bot_token',
    name: `${tableName} Slack`,
    sealed,
    idempotencyKey: randomUUID(),
    requestHash: commandKey(),
  });
  return connectionId;
}

async function publishCallableTool(
  authoring: ReturnType<typeof createWorkflowAuthoringStore>,
  parentName: string,
  {
    child,
    ...settings
  }: Extract<
    NonNullable<Parameters<typeof startAgentRun>[2]>,
    { child: WorkflowGraph }
  >,
) {
  if (child.callable === undefined)
    throw new Error('Fixture child has no contract');
  const { version } = await publishAgentFixtureGraph(
    authoring,
    child,
    `${parentName} child`,
  );
  return {
    ...settings,
    input: child.callable.input,
    target: {
      workflowId: version.workflowId,
      workflowVersionId: version.id,
      executableChecksum: version.checksum,
    },
  };
}

function withChildSlackWrite(
  child: WorkflowGraph,
  text: string,
  connectionId: string,
): WorkflowGraph {
  return {
    ...child,
    nodes: [
      ...child.nodes,
      {
        ...node('send', 'slack.send_message'),
        config: { timeoutMillis: 10_000 },
        inputMappings: {
          channelId: { kind: 'literal', value: slackChannel },
          text: { kind: 'literal', value: text },
        },
        connectionRefs: { slack_bot_token: connectionId },
      },
    ],
    edges: [edge('manual', 'send'), edge('send', 'finish')],
  };
}
