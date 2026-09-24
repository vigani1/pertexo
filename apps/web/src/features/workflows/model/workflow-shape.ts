import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type StepSource = Pick<WorkflowNode, 'definition' | 'label'>;

export type TriggerKind = 'webhook' | 'schedule' | 'manual';

const TRIGGER_KINDS: ReadonlyMap<string, TriggerKind> = new Map([
  ['core.webhook', 'webhook'],
  ['core.schedule', 'schedule'],
  ['core.manual', 'manual'],
]);
const TRIGGER_ORDER: readonly TriggerKind[] = ['webhook', 'schedule', 'manual'];

// A client registry of readable step names until the catalog carries display
// names. Unknown definitions fall back to their key's last segment.
const STEP_NAMES: ReadonlyMap<string, string> = new Map([
  ['core.webhook', 'Webhook'],
  ['core.schedule', 'Schedule'],
  ['core.manual', 'Manual start'],
  ['core.validate', 'Validate'],
  ['core.condition', 'Condition'],
  ['core.switch', 'Switch'],
  ['core.merge', 'Merge'],
  ['core.parallel', 'Parallel'],
  ['core.foreach', 'For each'],
  ['core.set', 'Set values'],
  ['core.wait', 'Wait'],
  ['core.terminate', 'Stop'],
  ['http.request', 'HTTP request'],
  ['slack.send_message', 'Send to Slack'],
  ['email.send_notification', 'Send email'],
]);

export function definitionName(key: string): string {
  const known = STEP_NAMES.get(key);
  if (known !== undefined) return known;
  const words = (key.split('.').at(-1) ?? key).replaceAll('_', ' ').trim();
  return words === ''
    ? key
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The name a person gave the step, else its definition's readable name. */
export function stepLabel(node: StepSource): string {
  const label = node.label?.trim();
  return label === undefined || label === ''
    ? definitionName(node.definition.key)
    : label;
}

export function triggerKindOf(definitionKey: string): TriggerKind | undefined {
  return TRIGGER_KINDS.get(definitionKey);
}

/** Distinct trigger kinds in the graph, in a stable display order. */
export function workflowTriggerKinds(
  graph: Pick<WorkflowGraphContract, 'nodes'>,
): readonly TriggerKind[] {
  const present = new Set(
    graph.nodes.flatMap((node) => {
      const kind = triggerKindOf(node.definition.key);
      return kind === undefined ? [] : [kind];
    }),
  );
  return TRIGGER_ORDER.filter((kind) => present.has(kind));
}

type Adjacency = Readonly<{
  successors: ReadonlyMap<string, readonly string[]>;
  incoming: ReadonlyMap<string, number>;
}>;

function adjacency(graph: WorkflowGraphContract): Adjacency {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const successors = new Map<string, string[]>(
    graph.nodes.map((node) => [node.id, []]),
  );
  const incoming = new Map<string, number>(
    graph.nodes.map((node) => [node.id, 0]),
  );
  for (const edge of graph.edges) {
    const from = edge.source.nodeId;
    const to = edge.target.nodeId;
    const targets = successors.get(from);
    if (from === to || !ids.has(to) || targets === undefined) continue;
    if (targets.includes(to)) continue;
    targets.push(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  return { successors, incoming };
}

/** Where a person reads the workflow from: its trigger, else a source step. */
function entryNode(
  graph: WorkflowGraphContract,
  incoming: ReadonlyMap<string, number>,
): WorkflowNode | undefined {
  const sources = graph.nodes.filter((node) => incoming.get(node.id) === 0);
  return (
    sources.find((node) => triggerKindOf(node.definition.key) !== undefined) ??
    sources[0] ??
    graph.nodes[0]
  );
}

/**
 * A short sentence of the main path, e.g. "Webhook → Validate → Send email".
 * Branches end the sentence with their first two options.
 */
export function describeWorkflowPath(
  graph: WorkflowGraphContract,
  maxSteps = 4,
): string {
  const { successors, incoming } = adjacency(graph);
  const entry = entryNode(graph, incoming);
  if (entry === undefined) return 'No steps yet';
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const labelOf = (id: string) => {
    const node = byId.get(id);
    return node === undefined ? 'Step' : stepLabel(node);
  };
  const parts = [stepLabel(entry)];
  const visited = new Set([entry.id]);
  let current = entry;
  for (;;) {
    const next = (successors.get(current.id) ?? []).filter(
      (id) => !visited.has(id),
    );
    const [first, second] = next;
    if (first === undefined) break;
    if (parts.length >= maxSteps) {
      parts.push('…');
      break;
    }
    if (second !== undefined) {
      const joiner = current.definition.key === 'core.parallel' ? 'and' : 'or';
      parts.push(
        next.length === 2
          ? `${labelOf(first)} ${joiner} ${labelOf(second)}`
          : `${labelOf(first)} ${joiner} ${String(next.length - 1)} more`,
      );
      break;
    }
    const node = byId.get(first);
    if (node === undefined) break;
    visited.add(first);
    parts.push(stepLabel(node));
    current = node;
  }
  return parts.join(' → ');
}

/**
 * Longest-path layers from the sources. A cycle (never valid, but possible in
 * a draft) is broken at its earliest unsettled step so layout always ends.
 */
function layerNodes(
  graph: WorkflowGraphContract,
  { successors, incoming }: Adjacency,
): Map<string, number> {
  const pending = new Map(incoming);
  const depth = new Map<string, number>();
  const queue = graph.nodes
    .filter((node) => pending.get(node.id) === 0)
    .map((node) => node.id);
  while (pending.size > 0) {
    const id =
      queue.shift() ?? graph.nodes.find((node) => pending.has(node.id))?.id;
    if (id === undefined) break;
    if (!pending.has(id)) continue;
    pending.delete(id);
    const own = depth.get(id) ?? 0;
    depth.set(id, own);
    for (const next of successors.get(id) ?? []) {
      if (!pending.has(next)) continue;
      depth.set(next, Math.max(depth.get(next) ?? 0, own + 1));
      const left = (pending.get(next) ?? 1) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return depth;
}

export type GlyphPoint = Readonly<{ x: number; y: number }>;
export type GlyphLayout = Readonly<{
  width: number;
  height: number;
  radius: number;
  nodes: readonly (GlyphPoint &
    Readonly<{ id: string; trigger: boolean; loop: boolean }>)[];
  edges: readonly Readonly<{ id: string; from: GlyphPoint; to: GlyphPoint }>[];
}>;

const round = (value: number) => Math.round(value * 10) / 10;

function spread(count: number, index: number, height: number): number {
  if (count <= 1) return height / 2;
  const inset = count === 2 ? height / 4 : height / 7;
  return inset + (index * (height - inset * 2)) / (count - 1);
}

/**
 * A tiny silhouette of the graph: one column per longest-path layer, steps in
 * a column ordered by their canvas position, the trigger marked.
 */
export function layoutPatternGlyph(
  graph: WorkflowGraphContract,
  size: Readonly<{ width: number; height: number }> = { width: 62, height: 28 },
): GlyphLayout {
  const links = adjacency(graph);
  const layer = layerNodes(graph, links);
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of graph.nodes) {
    const depth = layer.get(node.id) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const lastColumn = Math.max(0, ...columns.keys());
  const inset = 5;
  const columnWidth =
    lastColumn === 0 ? size.width : (size.width - inset * 2) / lastColumn;
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const rowGap =
    tallest === 1
      ? size.height
      : (size.height - spread(tallest, 0, size.height) * 2) / (tallest - 1);
  const radius = round(
    Math.min(2.4, Math.max(1.1, Math.min(columnWidth, rowGap) / 2.8)),
  );
  const entry = entryNode(graph, links.incoming);
  const points = new Map<string, GlyphPoint>();
  const nodes = [...columns.entries()].flatMap(([depth, column]) =>
    column
      .slice()
      .sort((a, b) => a.position.y - b.position.y)
      .map((node, index) => {
        const point = {
          x: round(
            lastColumn === 0 ? size.width / 2 : inset + depth * columnWidth,
          ),
          y: round(spread(column.length, index, size.height)),
        };
        points.set(node.id, point);
        return {
          ...point,
          id: node.id,
          trigger:
            node.id === entry?.id &&
            triggerKindOf(node.definition.key) !== undefined,
          loop: node.structured !== undefined,
        };
      }),
  );
  const edges = graph.edges.flatMap((edge) => {
    const from = points.get(edge.source.nodeId);
    const to = points.get(edge.target.nodeId);
    return from === undefined ||
      to === undefined ||
      edge.source.nodeId === edge.target.nodeId
      ? []
      : [{ id: edge.id, from, to }];
  });
  return { width: size.width, height: size.height, radius, nodes, edges };
}

/** A smooth thread between two dots, straight when it runs backwards. */
export function glyphEdgePath(from: GlyphPoint, to: GlyphPoint): string {
  if (to.x <= from.x)
    return `M${String(from.x)} ${String(from.y)}L${String(to.x)} ${String(to.y)}`;
  const middle = round((from.x + to.x) / 2);
  return `M${String(from.x)} ${String(from.y)}C${String(middle)} ${String(from.y)} ${String(middle)} ${String(to.y)} ${String(to.x)} ${String(to.y)}`;
}
