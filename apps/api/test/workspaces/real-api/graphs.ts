export function emptyWorkflowGraph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'manual', path: '$' },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-terminate',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  } as const;
}
