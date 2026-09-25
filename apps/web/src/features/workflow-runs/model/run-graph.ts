import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { StatusTone } from '@/components/ui/status';
import type { ThreadRow, ThreadStepStatus } from './thread-view';
import { describeStep, portName } from '@/features/catalog/presentation.public';

export type GraphStepStatus = ThreadStepStatus;

export type GraphStep = Readonly<{
  id: string;
  position: Readonly<{ x: number; y: number }>;
  label: string;
  kind: string;
  status: GraphStepStatus;
  tone: StatusTone;
  statusLabel: string;
  invocations: number;
  inputs: readonly string[];
  outputs: readonly string[];
}>;

export type GraphLink = Readonly<{
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  tone: StatusTone;
  /** Work is flowing into the target step right now. */
  active: boolean;
  /** The branch this connection leaves from ("true", "Branch 2"), if any. */
  branch?: string;
  /** The run didn't take this path: its target was skipped. */
  skipped: boolean;
}>;

// When one step ran several times, the map shows the most telling status.
const statusPriority: Readonly<Record<GraphStepStatus, number>> = {
  not_started: 0,
  pending: 1,
  skipped: 2,
  succeeded: 3,
  canceled: 4,
  timed_out: 5,
  failed: 6,
  outcome_unknown: 7,
  ready: 8,
  waiting: 9,
  running: 10,
};

const activeStatuses = new Set<GraphStepStatus>([
  'ready',
  'running',
  'waiting',
]);

interface Ports {
  inputs: Set<string>;
  outputs: Set<string>;
}

function collectPorts(graph: WorkflowGraphContract): Map<string, Ports> {
  const ports = new Map<string, Ports>();
  const portsFor = (nodeId: string) => {
    const known = ports.get(nodeId);
    if (known !== undefined) return known;
    const created = { inputs: new Set<string>(), outputs: new Set<string>() };
    ports.set(nodeId, created);
    return created;
  };
  for (const edge of graph.edges) {
    portsFor(edge.source.nodeId).outputs.add(edge.source.port);
    portsFor(edge.target.nodeId).inputs.add(edge.target.port);
  }
  return ports;
}

function strongestRow(rows: readonly ThreadRow[]): ThreadRow | undefined {
  let strongest: ThreadRow | undefined;
  for (const row of rows)
    if (
      strongest === undefined ||
      statusPriority[row.status] > statusPriority[strongest.status]
    )
      strongest = row;
  return strongest;
}

/** Nodes and edges of the version, coloured by what happened in this run. */
export function projectRunGraph(
  graph: WorkflowGraphContract,
  rows: readonly ThreadRow[],
): Readonly<{ nodes: readonly GraphStep[]; edges: readonly GraphLink[] }> {
  const rowsByNode = new Map<string, ThreadRow[]>();
  for (const row of rows)
    rowsByNode.set(row.nodeId, [...(rowsByNode.get(row.nodeId) ?? []), row]);
  const ports = collectPorts(graph);
  const looks = new Map<string, Pick<GraphStep, 'status' | 'tone'>>();
  const nodes = graph.nodes.map((node): GraphStep => {
    const invocations = (rowsByNode.get(node.id) ?? []).filter(
      (row) => row.status !== 'not_started',
    );
    const strongest = strongestRow(rowsByNode.get(node.id) ?? []);
    const status = strongest?.status ?? 'not_started';
    const tone = strongest?.tone ?? 'neutral';
    looks.set(node.id, { status, tone });
    const kind = describeStep(node.definition.key).name;
    const custom = node.label?.trim();
    const nodePorts = ports.get(node.id);
    return {
      id: node.id,
      position: node.position,
      label: custom === undefined || custom === '' ? kind : custom,
      kind: `${kind} · v${String(node.definition.version)}`,
      status,
      tone,
      statusLabel: strongest?.statusLabel ?? 'Not started',
      invocations: invocations.length,
      inputs: nodePorts === undefined ? [] : [...nodePorts.inputs],
      outputs: nodePorts === undefined ? [] : [...nodePorts.outputs],
    };
  });
  const edges = graph.edges.map((edge): GraphLink => {
    const target = looks.get(edge.target.nodeId);
    return {
      id: edge.id,
      source: edge.source.nodeId,
      sourceHandle: edge.source.port,
      target: edge.target.nodeId,
      targetHandle: edge.target.port,
      tone: target?.tone ?? 'neutral',
      active: target !== undefined && activeStatuses.has(target.status),
      ...(edge.source.port === 'out'
        ? {}
        : { branch: portName(edge.source.port) }),
      skipped: target?.status === 'skipped',
    };
  });
  return { nodes, edges };
}
