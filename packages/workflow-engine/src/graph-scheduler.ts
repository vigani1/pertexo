import { invocationKey } from './scheduling.js';
import { WorkflowEngineError } from './errors.js';
import {
  indexSchedulerGraph,
  type SchedulerGraphIndexes,
} from './graph-scheduler-indexes.js';
import { compareOrdinal } from './ordering.js';
import { branchPathHasPrefix, sameIterationPath } from './scope.js';
import type {
  BranchScopePart,
  BranchSelection,
  InvocationState,
  IterationScopePart,
} from './types.js';
import type { SideEffectClass } from './types.js';
import { isCoreParallelDefinition } from './core-definition-identities.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly deriveReadiness: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly definition?: { readonly key: string; readonly version: number };
    readonly config?: unknown;
    readonly disabled?: boolean;
    readonly sideEffectClass: SideEffectClass;
  }[];
  readonly edges: readonly {
    readonly source: { readonly nodeId: string; readonly port: string };
    readonly target: { readonly nodeId: string; readonly port: string };
  }[];
  readonly structuredBodies?: readonly {
    readonly loopNodeId: string;
    readonly nodes: SchedulerState['nodes'];
    readonly edges: SchedulerState['edges'];
  }[];
}

export function configuredBranchOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: unknown;
  }>,
): readonly string[] | undefined {
  if (
    node.definition?.key === 'core.condition' &&
    node.definition.version === 1
  )
    return ['false', 'true'];
  if (node.definition?.key !== 'core.switch' || node.definition.version !== 1)
    return undefined;
  if (
    typeof node.config !== 'object' ||
    node.config === null ||
    Array.isArray(node.config)
  )
    return undefined;
  const cases = Reflect.get(node.config, 'cases') as unknown;
  if (!Array.isArray(cases)) return undefined;
  const ports = cases.map((item): unknown =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Reflect.get(item, 'id')
      : undefined,
  );
  if (
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^case-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length
  )
    return undefined;
  return [...(ports as string[]), 'default'];
}

export function configuredParallelOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: unknown;
  }>,
): readonly string[] | undefined {
  if (
    !isCoreParallelDefinition(node.definition) ||
    typeof node.config !== 'object' ||
    node.config === null ||
    Array.isArray(node.config)
  )
    return undefined;
  const branches = Reflect.get(node.config, 'branches') as unknown;
  if (!Array.isArray(branches)) return undefined;
  const ports = branches.map((item): unknown =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Reflect.get(item, 'id')
      : undefined,
  );
  if (
    ports.length < 2 ||
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^branch-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length
  )
    return undefined;
  return ports as string[];
}

export function configuredParallelMaxConcurrency(
  node: Parameters<typeof configuredParallelOutputPorts>[0],
): number | undefined {
  const ports = configuredParallelOutputPorts(node);
  if (
    ports === undefined ||
    typeof node.config !== 'object' ||
    node.config === null
  )
    return undefined;
  const value = Reflect.get(node.config, 'maxConcurrency') as unknown;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ports.length
    ? value
    : undefined;
}

export function configuredScopedOutputPorts(
  node: Parameters<typeof configuredBranchOutputPorts>[0],
): readonly string[] | undefined {
  return (
    configuredBranchOutputPorts(node) ?? configuredParallelOutputPorts(node)
  );
}

export interface ReadyNodeDecision {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly disposition: 'ready' | 'skipped';
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
}

type SchedulerNode = SchedulerState['nodes'][number];

type DeriveReadyNodesInput = Readonly<{
  readonly graph: SchedulerState;
  readonly workflowVersionId: string;
  readonly invocations: readonly InvocationState[];
  readonly branchSelections?: readonly BranchSelection[];
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
}>;

interface SchedulerIndexes extends SchedulerGraphIndexes {
  readonly nodeById: ReadonlyMap<string, SchedulerNode>;
  readonly invocationByKey: ReadonlyMap<string, InvocationState>;
  readonly invocationByNode: ReadonlyMap<string, InvocationState>;
  readonly localSelections: readonly BranchSelection[];
}

interface SchedulerMarks {
  readonly blocked: Set<string>;
  readonly skipped: Set<string>;
  readonly branchPathByNode: Map<string, readonly BranchScopePart[]>;
}

function descendants(
  roots: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  boundaries: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reached.has(nodeId)) continue;
    if (boundaries.has(nodeId)) continue;
    reached.add(nodeId);
    pending.push(...(adjacency.get(nodeId) ?? []));
  }
  return reached;
}

function matchesSchedulerScope(
  invocation: Pick<InvocationState, 'branchPath' | 'iterationPath'> | undefined,
  input: Pick<DeriveReadyNodesInput, 'branchPath' | 'iterationPath'>,
  exactBranchPath: boolean,
): boolean {
  const branchPath = input.branchPath ?? [];
  return (
    invocation !== undefined &&
    sameIterationPath(invocation.iterationPath, input.iterationPath) &&
    (!exactBranchPath ||
      (invocation.branchPath?.length ?? 0) === branchPath.length) &&
    branchPathHasPrefix(invocation.branchPath, branchPath)
  );
}

function encodedBranchPath(
  branchPath: readonly BranchScopePart[],
): readonly string[] {
  return branchPath.map((part) => `${part.nodeId}:${part.outputPort}`);
}
function indexInvocations(input: DeriveReadyNodesInput): SchedulerIndexes {
  const nodeById = new Map<string, SchedulerNode>(
    input.graph.nodes.map((node) => [node.id, node]),
  );
  const invocationByKey = new Map<string, InvocationState>(
    input.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const localSelections = (input.branchSelections ?? []).filter(
    (selection) =>
      nodeById.has(selection.nodeId) &&
      matchesSchedulerScope(
        invocationByKey.get(selection.invocationKey),
        input,
        true,
      ),
  );
  const invocationByNode = new Map<string, InvocationState>();
  for (const invocation of input.invocations.filter((candidate) =>
    matchesSchedulerScope(candidate, input, false),
  )) {
    const existing = invocationByNode.get(invocation.nodeId);
    const isRoot =
      invocation.invocationKey ===
      invocationKey({
        workflowVersionId: input.workflowVersionId,
        nodeId: invocation.nodeId,
        ...(invocation.branchPath && {
          branchPath: encodedBranchPath(invocation.branchPath),
        }),
        ...(invocation.iterationPath && {
          iterationPath: invocation.iterationPath,
        }),
      });
    if (existing === undefined || isRoot)
      invocationByNode.set(invocation.nodeId, invocation);
  }
  return {
    nodeById,
    invocationByKey,
    invocationByNode,
    localSelections,
    ...indexSchedulerGraph(input.graph, nodeById),
  };
}

function validateBranchSelections(indexes: SchedulerIndexes): void {
  for (const selection of indexes.localSelections) {
    const node = indexes.nodeById.get(selection.nodeId);
    const invocation = indexes.invocationByKey.get(selection.invocationKey);
    const outputPorts =
      node === undefined ? undefined : configuredBranchOutputPorts(node);
    if (
      outputPorts === undefined ||
      invocation?.nodeId !== selection.nodeId ||
      invocation.status !== 'succeeded' ||
      invocation.output === undefined ||
      !outputPorts.includes(selection.selectedOutputPort)
    )
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        'branch selection disagrees with the pinned node contract',
      );
  }
}

function rememberBranchPath(
  marks: SchedulerMarks,
  nodeId: string,
  branchPath: readonly BranchScopePart[],
): void {
  if ((marks.branchPathByNode.get(nodeId)?.length ?? -1) < branchPath.length)
    marks.branchPathByNode.set(nodeId, branchPath);
}

function markReachableDescendants(
  roots: readonly string[],
  indexes: SchedulerIndexes,
  marks: SchedulerMarks,
  branchPath?: readonly BranchScopePart[],
  skipped = false,
): void {
  const reached = descendants(roots, indexes.adjacency, indexes.mergeNodeIds);
  for (const nodeId of reached) {
    if (branchPath === undefined) marks.blocked.add(nodeId);
    else rememberBranchPath(marks, nodeId, branchPath);
    if (skipped) marks.skipped.add(nodeId);
  }
}

function markConditionalBranches(
  input: DeriveReadyNodesInput,
  indexes: SchedulerIndexes,
  marks: SchedulerMarks,
): void {
  for (const branchNode of input.graph.nodes.filter(
    (node) => configuredBranchOutputPorts(node) !== undefined,
  )) {
    const invocation = indexes.invocationByNode.get(branchNode.id);
    if (invocation?.status !== 'succeeded') continue;
    const selection = indexes.localSelections.find(
      (candidate) =>
        candidate.invocationKey === invocation.invocationKey &&
        candidate.nodeId === branchNode.id,
    );
    const outgoing = input.graph.edges.filter(
      ({ source }) => source.nodeId === branchNode.id,
    );
    if (selection === undefined) {
      markReachableDescendants(
        outgoing.map(({ target }) => target.nodeId),
        indexes,
        marks,
      );
      continue;
    }
    for (const port of configuredBranchOutputPorts(branchNode) ?? []) {
      const branchPath = [
        ...(invocation.branchPath ?? []),
        { nodeId: branchNode.id, outputPort: port },
      ];
      markReachableDescendants(
        outgoing
          .filter((edge) => edge.source.port === port)
          .map(({ target }) => target.nodeId),
        indexes,
        marks,
        branchPath,
        port !== selection.selectedOutputPort,
      );
    }
  }
}

function markParallelInvocation(
  input: DeriveReadyNodesInput,
  parallel: SchedulerNode,
  invocation: InvocationState,
  indexes: SchedulerIndexes,
  marks: SchedulerMarks,
): void {
  const skipped = invocation.status === 'skipped';
  const basePath =
    invocation.branchPath ?? (skipped ? input.branchPath : undefined);
  const outgoing = input.graph.edges.filter(
    ({ source }) => source.nodeId === parallel.id,
  );
  for (const port of configuredParallelOutputPorts(parallel) ?? []) {
    const branchPath = [
      ...(basePath ?? []),
      { nodeId: parallel.id, outputPort: port },
    ];
    markReachableDescendants(
      outgoing
        .filter((edge) => edge.source.port === port)
        .map(({ target }) => target.nodeId),
      indexes,
      marks,
      branchPath,
      skipped,
    );
  }
  if (!skipped) return;
  const pairedMergeId = indexes.pairedMergeByParallel.get(parallel.id);
  if (pairedMergeId === undefined) return;
  marks.skipped.add(pairedMergeId);
  if (basePath !== undefined)
    rememberBranchPath(marks, pairedMergeId, basePath);
  markReachableDescendants(
    input.graph.edges
      .filter(({ source }) => source.nodeId === pairedMergeId)
      .map(({ target }) => target.nodeId),
    indexes,
    marks,
    basePath,
    true,
  );
}

function isNodeReady(
  node: SchedulerNode,
  indexes: SchedulerIndexes,
  marks: SchedulerMarks,
): boolean {
  if (indexes.invocationByNode.has(node.id)) return false;
  if (marks.skipped.has(node.id)) return true;
  if (marks.blocked.has(node.id)) return false;
  const pairedParallelId = indexes.pairedParallelByMerge.get(node.id);
  if (
    pairedParallelId !== undefined &&
    indexes.invocationByNode.get(pairedParallelId)?.status !== 'skipped'
  )
    return false;
  return (indexes.predecessors.get(node.id) ?? []).every((predecessor) => {
    const state = indexes.invocationByNode.get(predecessor)?.status;
    return state === 'succeeded' || state === 'skipped';
  });
}

function readyNodeDecision(
  input: DeriveReadyNodesInput,
  node: SchedulerNode,
  marks: SchedulerMarks,
): ReadyNodeDecision {
  const branchPath = marks.branchPathByNode.get(node.id) ?? input.branchPath;
  return {
    invocationKey: invocationKey({
      workflowVersionId: input.workflowVersionId,
      nodeId: node.id,
      ...(branchPath && { branchPath: encodedBranchPath(branchPath) }),
      ...(input.iterationPath && { iterationPath: input.iterationPath }),
    }),
    nodeId: node.id,
    disposition:
      marks.skipped.has(node.id) || node.disabled === true
        ? 'skipped'
        : 'ready',
    ...(branchPath && { branchPath }),
    ...(input.iterationPath && { iterationPath: input.iterationPath }),
  };
}

export function deriveReadyNodes(
  input: DeriveReadyNodesInput,
): readonly ReadyNodeDecision[] {
  const indexes = indexInvocations(input);
  validateBranchSelections(indexes);
  const marks: SchedulerMarks = {
    blocked: new Set(),
    skipped: new Set(),
    branchPathByNode: new Map(),
  };
  markConditionalBranches(input, indexes, marks);
  for (const parallel of input.graph.nodes.filter(
    (node) => configuredParallelOutputPorts(node) !== undefined,
  )) {
    const invocation = indexes.invocationByNode.get(parallel.id);
    if (invocation?.status === 'skipped' || invocation?.status === 'succeeded')
      markParallelInvocation(input, parallel, invocation, indexes, marks);
  }
  return [...input.graph.nodes]
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .filter((node) => isNodeReady(node, indexes, marks))
    .map((node) => readyNodeDecision(input, node, marks));
}
