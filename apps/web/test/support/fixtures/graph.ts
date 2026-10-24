import type { WorkflowGraphContract } from '@pertexo/contracts';

type GraphNode = WorkflowGraphContract['nodes'][number];
type NodeFixtureOptions = Pick<GraphNode, 'id'> &
  Partial<Omit<GraphNode, 'id'>>;

export function createWorkflowNodeFixture({
  id,
  definition = { key: 'core.set', version: 1 },
  ...overrides
}: NodeFixtureOptions): GraphNode {
  return {
    id,
    definition,
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

export function createWorkflowEdgeFixture({
  source,
  target,
  id = `${source}-${target}`,
  sourcePort = 'out',
}: Readonly<{
  source: string;
  target: string;
  id?: string;
  sourcePort?: string;
}>): WorkflowGraphContract['edges'][number] {
  return {
    id,
    source: { nodeId: source, port: sourcePort },
    target: { nodeId: target, port: 'in' },
  };
}
