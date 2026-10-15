import {
  approvalConfigSchema,
  formConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import type { WorkflowNode } from './scopes';

type NodeConfig = WorkflowNode['config'];

// How a new step starts, for the steps whose setup would otherwise begin
// empty and invalid. Values sit inside each schema's bounds (the catalog
// has no defaults). Authoring materializes these settings under ADR 069's
// current pre-launch contract.
const STARTING: Readonly<Record<string, NodeConfig>> = {
  'core.read_file': { format: 'csv', delimiter: ',', convertValues: true },
  'core.batch': { size: 100 },
  'core.take': { count: 100 },
  'core.concat': {},
  'core.filter': { path: '$', operator: 'equals' },
  'core.sort': {
    path: '$',
    valueType: 'number',
    direction: 'ascending',
    missing: 'last',
  },
  'core.unique': { path: '$', missing: 'error' },
  'core.summarize': { valuePath: '$', missing: 'error' },
  'core.date': { operation: 'to_iso' },
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
  if (definitionKey === 'core.form') return formConfigSchema.parse({});
  if (definitionKey === 'core.request_input')
    return inputRequestConfigSchema.parse({});
  if (definitionKey === 'core.approval') return approvalConfigSchema.parse({});
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

/** Changing Date operation replaces its exact variant in one undoable edit. */
export function dateOperationConfig(operation: string): NodeConfig | undefined {
  switch (operation) {
    case 'to_iso':
    case 'to_epoch_millis':
      return { operation };
    case 'format':
      return { operation, format: 'date_only', timeZone: 'UTC' };
    case 'convert_timezone':
      return { operation, timeZone: 'UTC' };
    case 'add_duration':
      return { operation, unit: 'days' };
    default:
      return undefined;
  }
}
