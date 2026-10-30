const manual = {
  id: 'manual',
  definition: { key: 'core.manual', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
};

export type HttpStep = Readonly<{
  id: string;
  method: 'GET' | 'POST';
  url: string;
}>;

function httpNode({ id, method, url }: HttpStep, index: number) {
  return {
    id,
    label: id,
    definition: { key: 'http.request', version: 1 },
    position: { x: (index + 1) * 10, y: 0 },
    configVersion: 1,
    config: {
      method,
      url,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      timeoutMillis: 120_000,
      maxRedirects: 0,
      maxResponseBytes: 4_096,
      inlineResponseBytes: 4_096,
    },
    inputMappings:
      method === 'POST'
        ? { body: { kind: 'literal', value: { encoding: 'utf8', value: id } } }
        : {},
    connectionRefs: {},
  };
}

/** A published graph of HTTP steps in a line, the workflow a beta user builds. */
export function httpChain(
  steps: readonly HttpStep[],
  settings: Readonly<{ maxRunDurationMs?: number }> = {},
) {
  const nodes = steps.map(httpNode);
  const order = [manual, ...nodes];
  return {
    settings,
    nodes: order,
    edges: nodes.map((node, index) => ({
      id: `e${String(index)}`,
      source: { nodeId: order[index]?.id ?? 'manual', port: 'out' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
}
