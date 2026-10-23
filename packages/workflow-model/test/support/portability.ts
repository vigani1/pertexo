import type { WorkflowGraph } from '../../src/graph/contract.js';

import type { WorkflowPortabilityCatalog } from '../../src/authoring/portability/projection.js';
export const catalog: WorkflowPortabilityCatalog = {
  definitions: ['core.set', 'core.foreach', 'http.request'].map((key) => ({
    key,
    version: 1,
    configVersion: 1,
    validateConfig: (config) => config.invalid === undefined,
    slots:
      key === 'http.request'
        ? [
            {
              slot: 'http_headers',
              providerKey: 'http',
              authType: 'http_headers',
            },
          ]
        : [],
  })),
};
export const node = (
  id: string,
  key = 'core.set',
): WorkflowGraph['nodes'][number] => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
});
export const graph = (nodes: WorkflowGraph['nodes']): WorkflowGraph => ({
  nodes,
  edges: [],
  settings: {},
});
export const connectionId = '11111111-1111-4111-8111-111111111111';
