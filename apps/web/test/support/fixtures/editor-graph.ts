import type { WorkflowGraphContract } from '@pertexo/contracts';
export function graphWithNumericConfig(
  config: WorkflowGraphContract['nodes'][number]['config'],
): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        definition: { key: 'core.set', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config,
        inputMappings: {},
        connectionRefs: {},
        label: 'Numbers',
      },
    ],
    edges: [],
    settings: {},
  };
}

export const oneStepGraph = graphWithNumericConfig({});

export function graphWithMappingNodes(
  inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'] = {},
): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        label: 'Manual input',
      },
      {
        id: 'target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 340, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs: {},
        label: 'Target',
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
