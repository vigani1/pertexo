import type { EdgeTuple } from './contract.js';

export function edgesFromTuples(edges: readonly EdgeTuple[]) {
  return edges.map(
    ([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    }),
  );
}

export const manualNode = {
  id: 'manual',
  definition: { key: 'core.manual', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
} as const;

export function setNode(id: string, y: number, value = id) {
  return {
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 20, y },
    configVersion: 1,
    config: {},
    inputMappings: {
      value: { kind: 'literal' as const, value },
    },
    connectionRefs: {},
  };
}
