import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
export type WorkflowNode = WorkflowGraphContract['nodes'][number];

export const etag = `"draft.${'a'.repeat(43)}"`;

export function node(
  id: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

export function edge(id: string, source: string, target: string, port = 'out') {
  return {
    id,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

export function branchingGraph(): WorkflowGraphContract {
  return {
    nodes: [
      node('trigger'),
      node('check'),
      node('finance'),
      node('post', {
        inputMappings: {
          amount: { kind: 'node_output', nodeId: 'check', path: '$.amount' },
        },
      }),
    ],
    edges: [
      edge('e1', 'trigger', 'check'),
      edge('e2', 'check', 'finance', 'true'),
      edge('e3', 'check', 'post', 'false'),
    ],
    settings: {},
  };
}

export const definition = {
  definition: { key: 'slack.send_message', version: 1 },
  family: 'action',
  configVersion: 1,
  configSchema: {},
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: ['slack_bot_token'],
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: [],
} satisfies NodeDefinitionCatalogItem;
