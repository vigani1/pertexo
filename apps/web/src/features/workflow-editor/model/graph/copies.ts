import { graphSteps } from '@/features/workflow-drafts/public';
import jsonata from 'jsonata';
import { isRecord, remapCallbackReferences } from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { cardSize, overlaps, settleBodyLayout } from './for-each-body-layout';
import {
  groupByScope,
  findStep,
  mapLevel,
  scopeOf,
  type GraphLevel,
  type WorkflowEdge,
  type WorkflowNode,
} from './scopes';

// Copies of steps: duplicates made on the canvas.

type Position = Readonly<{ x: number; y: number }>;
type CreateId = () => string;

/**
 * Copies steps with fresh IDs, each on its own level, placed just below the
 * copied steps and clear of any other step (or `offset` from the originals
 * when given). Links between copied steps are copied too, and mappings that
 * read a copied step follow it. A copied For each gets a copy of its body,
 * with fresh IDs throughout, since IDs are unique across the workflow.
 */
export function duplicateWorkflowNodes(
  graph: WorkflowGraphContract,
  nodeIds: readonly string[],
  createId: CreateId = () => crypto.randomUUID(),
  offset?: Position,
): Readonly<{
  graph: WorkflowGraphContract;
  nodeIds: readonly string[];
  expressionReviewNeeded: boolean;
}> {
  let next = graph;
  const copied: string[] = [];
  for (const group of groupByScope(nodeIds, (id) => scopeOf(graph, id)))
    next = mapLevel(
      next,
      group.scope,
      (level) => {
        const result = copySteps(level, group.ids, createId, offset);
        copied.push(...result.nodeIds);
        return result.level;
      },
      settleBodyLayout,
    );
  const copiedRoots = copied.flatMap((id) => {
    const node = findStep(next, id);
    return node === undefined ? [] : [node];
  });
  const expressionReviewNeeded = graphSteps({ nodes: copiedRoots }).some(
    ({ node }) =>
      Object.values(node.inputMappings).some(
        (source) =>
          source.kind === 'expression' &&
          hasDynamicStepReferences(source.expression),
      ),
  );
  return { graph: next, nodeIds: copied, expressionReviewNeeded };
}

function copySteps<Level extends GraphLevel>(
  level: Level,
  nodeIds: readonly string[],
  createId: CreateId,
  offset: Position | undefined,
): Readonly<{ level: Level; nodeIds: readonly string[] }> {
  const wanted = new Set(nodeIds);
  const sources = level.nodes.filter((node) => wanted.has(node.id));
  if (sources.length === 0) return { level, nodeIds: [] };
  const idMap = new Map(sources.map((node) => [node.id, createId()]));
  const shift = offset ?? clearOffset(level, sources);
  const copies = sources.map((node) => ({
    ...copyStep(node, idMap, createId, level.nodes),
    position: { x: node.position.x + shift.x, y: node.position.y + shift.y },
  }));
  return {
    level: {
      ...level,
      nodes: [...level.nodes, ...copies],
      edges: [...level.edges, ...copyEdges(level.edges, idMap, createId)],
    },
    nodeIds: copies.map((node) => node.id),
  };
}

const COPY_GAP = 24;

/**
 * How far down to move copies so none covers a step: at least the copied
 * group's own height, then further while any copy would sit on another.
 */
function clearOffset(
  level: GraphLevel,
  sources: readonly WorkflowNode[],
): Position {
  const top = Math.min(...sources.map((node) => node.position.y));
  const bottom = Math.max(
    ...sources.map((node) => node.position.y + cardSize(node).height),
  );
  let y = bottom - top + COPY_GAP;
  for (let attempt = 0; attempt <= level.nodes.length; attempt += 1) {
    const blocked = sources.some((source) => {
      const copy = {
        x: source.position.x,
        y: source.position.y + y,
        ...cardSize(source),
      };
      return level.nodes.some((node) =>
        overlaps(copy, { ...node.position, ...cardSize(node) }),
      );
    });
    if (!blocked) break;
    y += 80 + COPY_GAP;
  }
  return { x: 0, y: Math.round(y) };
}

/** A step under its new ID, reading copied steps instead of originals. */
function copyStep(
  node: WorkflowNode,
  idMap: ReadonlyMap<string, string>,
  createId: CreateId,
  levelNodes: readonly WorkflowNode[],
): WorkflowNode {
  const parallelId = node.config.parallelNodeId;
  const hasCopiedParallel =
    node.definition.key === 'core.merge' &&
    node.definition.version === 1 &&
    typeof parallelId === 'string' &&
    idMap.has(parallelId);
  const parallel = hasCopiedParallel
    ? levelNodes.find((candidate) => candidate.id === parallelId)
    : undefined;
  const remapParallel =
    parallel?.definition.key === 'core.parallel' &&
    parallel.definition.version === 1 &&
    typeof parallelId === 'string';
  const copy: WorkflowNode = {
    ...node,
    id: idMap.get(node.id) ?? createId(),
    config: remapParallel
      ? { ...node.config, parallelNodeId: idMap.get(parallelId) ?? parallelId }
      : node.config,
    inputMappings: Object.fromEntries(
      Object.entries(node.inputMappings).map(([key, source]) => [
        key,
        copiedSource(source, idMap),
      ]),
    ),
  };
  const structured = node.structured;
  if (structured === undefined) return copy;
  const body = structured.body;
  const bodyIds = new Map(body.nodes.map((step) => [step.id, createId()]));
  return {
    ...copy,
    structured: {
      ...structured,
      body: {
        ...body,
        nodes: body.nodes.map((step) =>
          copyStep(step, bodyIds, createId, body.nodes),
        ),
        edges: copyEdges(body.edges, bodyIds, createId),
      },
    },
  };
}

/** Links between copied steps, joining the copies. */
function copyEdges(
  edges: readonly WorkflowEdge[],
  idMap: ReadonlyMap<string, string>,
  createId: CreateId,
): readonly WorkflowEdge[] {
  return edges.flatMap((edge) => {
    const source = idMap.get(edge.source.nodeId);
    const target = idMap.get(edge.target.nodeId);
    if (source === undefined || target === undefined) return [];
    return [
      {
        id: createId(),
        source: { nodeId: source, port: edge.source.port },
        target: { nodeId: target, port: edge.target.port },
      },
    ];
  });
}

function copyExpression(
  expression: string,
  ids: ReadonlyMap<string, string>,
): string {
  try {
    const callbacks = remapCallbackReferences(
      expression,
      jsonata(expression).ast(),
      ids,
    );
    const edits: { start: number; end: number; value: string }[] = [];
    visitExpressionReferences(jsonata(callbacks).ast(), (reference) => {
      const replacement = ids.get(reference.nodeId);
      if (replacement === undefined) return;
      const token =
        /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[A-Za-z_$][\w$]*)$/u.exec(
          callbacks.slice(0, reference.end),
        );
      if (token !== null)
        edits.push({
          start: reference.end - token[0].length,
          end: reference.end,
          value: JSON.stringify(replacement),
        });
    });
    let result = callbacks;
    for (const edit of edits.sort((left, right) => right.start - left.start))
      result =
        result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    return result;
  } catch {
    return expression;
  }
}

function copiedSource(
  source: WorkflowNode['inputMappings'][string],
  idMap: ReadonlyMap<string, string>,
): WorkflowNode['inputMappings'][string] {
  const copiedNodeSource =
    (source.kind === 'node_output' || source.kind === 'node_failure') &&
    idMap.has(source.nodeId);
  if (copiedNodeSource)
    return { ...source, nodeId: idMap.get(source.nodeId) ?? source.nodeId };
  if (source.kind === 'expression')
    return {
      ...source,
      expression: copyExpression(source.expression, idMap),
    };
  return source;
}

/**
 * AST-selected static references; literal text and computed lookups keep
 * their meaning. A reference counts only where it reads the expression's
 * root: `$$` always does, while `$` and bare names do only where the context
 * is still the root (not in later path steps, filters, sorts, grouping or
 * transforms). Anything else is left alone and asks for review.
 */
function visitExpressionReferences(
  value: unknown,
  found: (
    reference: Readonly<{ nodeId: string; end: number; root: unknown }>,
  ) => void,
  atRoot = true,
): void {
  if (Array.isArray(value)) {
    for (const child of value) visitExpressionReferences(child, found, atRoot);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'path' && Array.isArray(value.steps)) {
    const steps = value.steps as unknown[];
    const [root, target] = workflowRootSteps(steps, atRoot) ?? [];
    const step = stepName(target, 'name');
    if (isOutputRoot(root) && step !== undefined) found({ ...step, root });
    for (const [index, step] of steps.entries())
      visitExpressionReferences(step, found, atRoot && index === 0);
    visitExpressionReferences(value.group, found, false);
    return;
  }
  const arguments_ = lookupArguments(value);
  if (arguments_ !== undefined) {
    const [root, target] = arguments_;
    const output = outputRoot(root, atRoot);
    const step = stepName(target, 'string');
    if (output !== undefined && step !== undefined)
      found({ ...step, root: output });
  }
  const keepsRoot = atRoot && ROOT_CONTEXT_TYPES.has(String(value.type));
  for (const [key, child] of Object.entries(value))
    visitExpressionReferences(
      child,
      found,
      keepsRoot && !ITEM_CONTEXT_KEYS.has(key),
    );
}

/** A literal step name in a reference, with where its token ends. */
function stepName(
  target: unknown,
  type: 'name' | 'string',
): Readonly<{ nodeId: string; end: number }> | undefined {
  return isRecord(target) &&
    target.type === type &&
    typeof target.value === 'string' &&
    typeof target.position === 'number'
    ? { nodeId: target.value, end: target.position }
    : undefined;
}

/**
 * Node types whose operands JSONata evaluates in the same context as the node
 * (a lambda body keeps the context it was defined in). Every other node, such
 * as a transform's pattern and update, may run against items, so references
 * beneath it are not taken as root references.
 */
const ROOT_CONTEXT_TYPES = new Set([
  'apply',
  'binary',
  'bind',
  'block',
  'condition',
  'function',
  'lambda',
  'partial',
  'unary',
]);

/** Parts of a step JSONata evaluates once per item, not against the root. */
const ITEM_CONTEXT_KEYS = new Set(['stages', 'predicate', 'group', 'terms']);

function lookupArguments(
  value: Record<string, unknown>,
): readonly unknown[] | undefined {
  return value.type === 'function' &&
    isRecord(value.procedure) &&
    value.procedure.type === 'variable' &&
    value.procedure.value === 'lookup' &&
    Array.isArray(value.arguments)
    ? value.arguments
    : undefined;
}

function outputRoot(value: unknown, atRoot: boolean): unknown {
  if (isOutputRoot(value)) return atRoot ? value : undefined;
  if (!isRecord(value) || value.type !== 'path' || !Array.isArray(value.steps))
    return undefined;
  const steps = workflowRootSteps(value.steps as unknown[], atRoot);
  return steps?.length === 1 && isOutputRoot(steps[0]) ? steps[0] : undefined;
}

/**
 * The steps after a path's root qualifier, or `undefined` when the path
 * doesn't start at the expression's root. `$$` is the root anywhere; a plain
 * `$` or a bare first name is the root only where the context is.
 */
function workflowRootSteps(
  steps: readonly unknown[],
  atRoot: boolean,
): readonly unknown[] | undefined {
  const [first] = steps;
  if (isPlainVariable(first, '$')) return steps.slice(1);
  if (!atRoot) return undefined;
  return isPlainVariable(first, '') ? steps.slice(1) : steps;
}

function isPlainVariable(step: unknown, name: '' | '$'): boolean {
  return (
    isRecord(step) &&
    step.type === 'variable' &&
    step.value === name &&
    step.predicate === undefined &&
    step.stages === undefined &&
    step.group === undefined
  );
}

function isOutputRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === 'name' &&
    (value.value === 'nodeOutputs' || value.value === 'nodeFailures')
  );
}

function hasDynamicStepReferences(expression: string): boolean {
  try {
    const ast: unknown = jsonata(expression).ast();
    const staticRoots = new Set<unknown>();
    visitExpressionReferences(ast, ({ root }) => {
      staticRoots.add(root);
    });
    function dynamic(value: unknown): boolean {
      if (Array.isArray(value)) return value.some(dynamic);
      if (!isRecord(value)) return false;
      return (
        (isOutputRoot(value) && !staticRoots.has(value)) ||
        Object.values(value).some(dynamic)
      );
    }
    return dynamic(ast);
  } catch {
    return true;
  }
}
