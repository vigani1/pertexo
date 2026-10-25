import type { WorkflowGraphContract } from '@pertexo/contracts';
export type WorkflowNode = WorkflowGraphContract['nodes'][number];

export function node(
  id: string,
  key: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

export function graph(
  nodes: readonly WorkflowNode[],
  edges: WorkflowGraphContract['edges'] = [],
): WorkflowGraphContract {
  return { nodes, edges, settings: {} };
}

export const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
  issues: [],
};

export const base = {
  enabled: true,
  saveStatus: 'clean',
  inspectorScratch: false,
  pending: false,
  revision: 4,
  generation: 9,
  checked: undefined,
  attemptedRevision: undefined,
} as const;
