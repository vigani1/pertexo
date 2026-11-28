import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';

// The invoice workflow the core-flow screenshots are built around.

const MINUTE_MS = 60_000;
const SCENARIO_TIME = Date.now();

/** A time this many minutes ago, as the API writes it. */
export const at = (minutesAgo: number) =>
  new Date(SCENARIO_TIME - minutesAgo * MINUTE_MS).toISOString();

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

/**
 * Support triage with AI steps: guardrails, then a classifier whose
 * categories open lanes, then an agent drafting the billing reply.
 */
export function triageGraph() {
  const classify = node('sort', 'ai.classify', 'Sort the ticket', [900, 200]);
  return {
    nodes: [
      node('ticket', 'core.manual', 'New ticket', [0, 200]),
      node('guard', 'ai.guardrails', 'Check for personal data', [300, 200]),
      node('stop', 'core.set', 'Stop run', [600, 420]),
      node('check', 'core.validate', 'Check the ticket', [600, 200]),
      {
        ...classify,
        config: {
          categories: [
            {
              id: 'category-01',
              label: 'billing',
              description: 'Invoices, refunds and payments.',
            },
            {
              id: 'category-02',
              label: 'bug',
              description: 'Something in the product is broken.',
            },
          ],
        },
      },
      node('reply', 'ai.agent', 'Draft reply', [1200, 200]),
      node('bugs', 'slack.send_message', 'Post to #bugs', [1200, 40]),
      node('queue', 'core.set', 'Add to queue', [1200, 380]),
    ],
    edges: [
      edge('ticket', 'guard'),
      edge('guard', 'check', 'pass'),
      edge('guard', 'stop', 'fail'),
      edge('check', 'sort'),
      edge('sort', 'reply', 'category-01'),
      edge('sort', 'bugs', 'category-02'),
      edge('sort', 'queue', 'other'),
    ],
    settings: {},
  };
}
