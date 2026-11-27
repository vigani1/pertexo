import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';

// The invoice workflow the core-flow screenshots are built around.

const MINUTE_MS = 60_000;

/** A time this many minutes ago, as the API writes it. */
export const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * MINUTE_MS).toISOString();

function latestVersions() {
  const byKey = new Map<string, number>();
  for (const { definition } of platformBrowserNodeDefinitionCatalog()
    .definitions)
    byKey.set(
      definition.key,
      Math.max(byKey.get(definition.key) ?? 0, definition.version),
    );
  return byKey;
}

/** A step of the catalog's newest version, placed at `[x, y]`. */
export function node(
  id: string,
  key: string,
  label: string,
  [x, y]: readonly [number, number],
) {
  return {
    id,
    label,
    definition: { key, version: latestVersions().get(key) ?? 1 },
    position: { x, y },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

export function edge(source: string, target: string, port = 'out') {
  return {
    id: `${source}-${port}-${target}`,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

/** New invoice → Check payload → Over 5,000? → approval or ERP → receipt. */
export function invoiceGraph() {
  return {
    nodes: [
      node('intake', 'core.manual', 'New invoice', [0, 200]),
      node('check', 'core.validate', 'Check payload', [300, 200]),
      node('over', 'core.condition', 'Over 5,000?', [600, 200]),
      node('approve', 'core.approval', 'Finance approval', [900, 40]),
      node('erp', 'http.request', 'Post to ERP', [1200, 200]),
      node('receipt', 'email.send_notification', 'Send receipt', [1500, 200]),
    ],
    edges: [
      edge('intake', 'check'),
      edge('check', 'over'),
      edge('over', 'approve', 'true'),
      edge('over', 'erp', 'false'),
      edge('approve', 'erp', 'approved'),
      edge('erp', 'receipt'),
    ],
    settings: {},
  };
}
