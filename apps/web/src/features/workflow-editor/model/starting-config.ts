import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { NodeConfig } from './inspector-draft';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

// How a new step starts, for the steps whose setup would otherwise begin
// empty and invalid. Values sit inside each schema's bounds (the catalog
// has no defaults, and a definition's schema can't change in place: ADR
// 010), so a new step reads as ready where it can be.
const STARTING: Readonly<Record<string, NodeConfig>> = {
  // Two branches, both at once.
  'core.parallel': {
    branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
    maxConcurrency: 2,
  },
  // One case to fill in; anything else goes out Default.
  'core.switch': { cases: [{ id: 'case-01', equals: '' }] },
  // A rule list the builder fills from its first "Add rule".
  'core.validate': { rules: [] },
  'core.wait': { durationSeconds: 60 },
  'email.send_notification': { timeoutMillis: 10_000 },
  'slack.send_message': { timeoutMillis: 10_000 },
  'http.request': {
    method: 'GET',
    headers: {},
    timeoutMillis: 10_000,
    maxRedirects: 3,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 65_536,
  },
};

/**
 * A new step's setup. A Merge waits for every branch, and joins the
 * Parallel on its level when there's exactly one to join.
 */
export function startingConfig(
  definitionKey: string,
  levelNodes: readonly WorkflowNode[],
): NodeConfig {
  if (definitionKey === 'core.merge') {
    const parallels = levelNodes.filter(
      (node) => node.definition.key === 'core.parallel',
    );
    const [only] = parallels;
    return {
      policy: { kind: 'all' },
      ...(parallels.length === 1 && only !== undefined
        ? { parallelNodeId: only.id }
        : {}),
    };
  }
  return structuredClone(STARTING[definitionKey] ?? {});
}
