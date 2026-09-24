import type {
  NodeDefinitionCatalogItem,
  NodeDefinitionListResponse,
} from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

export type StarterId =
  'webhook-http-slack' | 'schedule-http' | 'webhook-validate-email';

type StarterStep = Readonly<{ definitionKey: string; label: string }>;

export type WorkflowStarter = Readonly<{
  id: StarterId;
  title: string;
  description: string;
  steps: readonly StarterStep[];
}>;

// Client-side starting points until the API offers a template manifest.
const WORKFLOW_STARTERS: readonly WorkflowStarter[] = [
  {
    id: 'webhook-http-slack',
    title: 'Webhook → HTTP → Slack',
    description:
      'Receive an event, call an API, then post the result to Slack.',
    steps: [
      { definitionKey: 'core.webhook', label: 'Webhook' },
      { definitionKey: 'http.request', label: 'Call API' },
      { definitionKey: 'slack.send_message', label: 'Post to Slack' },
    ],
  },
  {
    id: 'schedule-http',
    title: 'Schedule → HTTP',
    description: 'Call an API on a timetable you choose.',
    steps: [
      { definitionKey: 'core.schedule', label: 'Schedule' },
      { definitionKey: 'http.request', label: 'Call API' },
    ],
  },
  {
    id: 'webhook-validate-email',
    title: 'Webhook → Validate → Email',
    description: 'Check incoming data, then email a notification.',
    steps: [
      { definitionKey: 'core.webhook', label: 'Webhook' },
      { definitionKey: 'core.validate', label: 'Validate' },
      { definitionKey: 'email.send_notification', label: 'Send email' },
    ],
  },
];

export type AvailableStarter = WorkflowStarter &
  Readonly<{ definitions: readonly NodeDefinitionCatalogItem[] }>;

/** The newest definition for a key that can be placed and published. */
function usableDefinition(
  catalog: NodeDefinitionListResponse,
  key: string,
): NodeDefinitionCatalogItem | undefined {
  return catalog.items
    .filter(
      (item) =>
        item.definition.key === key && item.available && item.publishable,
    )
    .reduce<NodeDefinitionCatalogItem | undefined>(
      (newest, item) =>
        newest === undefined ||
        item.definition.version > newest.definition.version
          ? item
          : newest,
      undefined,
    );
}

/**
 * Starters whose every step is available and publishable in this catalog,
 * and whose consecutive steps can actually be connected.
 */
export function availableStarters(
  catalog: NodeDefinitionListResponse,
): readonly AvailableStarter[] {
  return WORKFLOW_STARTERS.flatMap((starter) => {
    const definitions = starter.steps.map((step) =>
      usableDefinition(catalog, step.definitionKey),
    );
    if (definitions.some((definition) => definition === undefined)) return [];
    const usable = definitions.filter(
      (definition): definition is NodeDefinitionCatalogItem =>
        definition !== undefined,
    );
    const connectable = usable.every(
      (definition, index) =>
        index === usable.length - 1 ||
        (definition.ports.outputs.length > 0 &&
          (usable[index + 1]?.ports.inputs.length ?? 0) > 0),
    );
    return connectable ? [{ ...starter, definitions: usable }] : [];
  });
}

const STEP_SPACING = 280;

type LinearStep = Readonly<{
  definition: Readonly<{ key: string; version: number }>;
  configVersion: number;
  label: string;
  input: string | undefined;
  output: string | undefined;
}>;

/** Unconfigured steps joined in a line, each output to the next input. */
function linearGraph(
  steps: readonly LinearStep[],
  createId: () => string,
): WorkflowGraphContract {
  const nodes = steps.map((step, index) => ({
    id: createId(),
    definition: step.definition,
    position: { x: index * STEP_SPACING, y: 0 },
    configVersion: step.configVersion,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    label: step.label,
  }));
  const edges = nodes.slice(1).flatMap((target, index) => {
    const source = nodes[index];
    const sourcePort = steps[index]?.output;
    const targetPort = steps[index + 1]?.input;
    if (
      source === undefined ||
      sourcePort === undefined ||
      targetPort === undefined
    )
      return [];
    return [
      {
        id: createId(),
        source: { nodeId: source.id, port: sourcePort },
        target: { nodeId: target.id, port: targetPort },
      },
    ];
  });
  return { schemaVersion: 1, nodes, edges, settings: {} };
}

/** The starter as a draft graph built from this catalog's definitions. */
export function buildStarterGraph(
  starter: AvailableStarter,
  createId: () => string = () => crypto.randomUUID(),
): WorkflowGraphContract {
  return linearGraph(
    starter.definitions.map((definition, index) => ({
      definition: definition.definition,
      configVersion: definition.configVersion,
      label: starter.steps[index]?.label ?? definition.definition.key,
      input: definition.ports.inputs[0],
      output: definition.ports.outputs[0],
    })),
    createId,
  );
}

const previews = new Map<StarterId, WorkflowGraphContract>();

/** A starter's steps as a graph for its mini preview; no catalog needed. */
export function starterPreviewGraph(
  starter: WorkflowStarter,
): WorkflowGraphContract {
  const cached = previews.get(starter.id);
  if (cached !== undefined) return cached;
  let sequence = 0;
  const graph = linearGraph(
    starter.steps.map((step) => ({
      definition: { key: step.definitionKey, version: 1 },
      configVersion: 1,
      label: step.label,
      input: 'in',
      output: 'out',
    })),
    () => {
      sequence += 1;
      return `${starter.id}-${String(sequence)}`;
    },
  );
  previews.set(starter.id, graph);
  return graph;
}
