export function rejectedLoopGraph(
  items: readonly string[],
  ordinary = false,
  maxIterations = 3,
) {
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    schemaVersion: 1,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('loop', ordinary ? 'core.set' : 'core.foreach'),
        inputMappings: ordinary
          ? { value: { kind: 'literal', value: items } }
          : { items: { kind: 'literal', value: items } },
        ...(ordinary
          ? {}
          : {
              structured: {
                kind: 'for_each',
                maxIterations,
                maxConcurrency: 1,
                body: {
                  schemaVersion: 1,
                  settings: {},
                  nodes: [node('body', 'core.set')],
                  edges: [],
                  inputPorts: ['item', 'ordinal'],
                  outputPorts: ['result'],
                },
              },
            }),
      },
      node('terminate', 'core.terminate'),
    ],
    edges: [
      {
        id: 'start-loop',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'loop', port: 'in' },
      },
      {
        id: 'loop-end',
        source: { nodeId: 'loop', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}
