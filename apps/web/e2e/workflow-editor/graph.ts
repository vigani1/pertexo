import { createWorkflowNodeFixture } from '../../test/support/fixtures/graph';
import type { Graph } from './support';
export function editorNode(
  id: string,
  label: string,
  value: string,
  x: number,
) {
  return createWorkflowNodeFixture({
    id,
    label,
    config: { value },
    position: { x, y: 80 },
  });
}

export function mappingGraph(): Graph {
  return {
    nodes: [
      {
        id: 'manual',
        label: 'Manual input',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target',
        label: 'Target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 380, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-target',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'target', port: 'in' },
      },
    ],
    settings: {},
  };
}
