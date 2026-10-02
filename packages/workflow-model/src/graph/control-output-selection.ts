import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '../graph-contract.js';

export type WorkflowControlOutputKind = 'branch' | 'parallel' | 'for_each';

/** Definition identity, not output property names, determines control materialization. */
export function workflowControlOutputKind(
  definition: Readonly<{ key: string; version: number }> | undefined,
): WorkflowControlOutputKind | undefined {
  if (definition?.version === 1) {
    if (definition.key === 'core.condition' || definition.key === 'core.switch')
      return 'branch';
    if (definition.key === 'core.foreach') return 'for_each';
  }
  if (
    definition?.key === 'core.parallel' &&
    [1, 2, 3].includes(definition.version)
  )
    return 'parallel';
  return undefined;
}

/** Selects node IDs from the immutable compiled V2 envelope. */
export function workflowControlOutputNodeIdsV2(
  executableJson: unknown,
): ReadonlySet<string> {
  if (
    typeof executableJson !== 'object' ||
    executableJson === null ||
    Array.isArray(executableJson) ||
    Reflect.get(executableJson, 'schemaVersion') !== 2
  )
    throw new TypeError('V2 executable control metadata is invalid');
  const pending: unknown[] = [Reflect.get(executableJson, 'graph')];
  const ids = new Set<string>();
  const seen = new Set<string>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current)
    )
      throw new TypeError('V2 executable control graph is invalid');
    const nodes = Reflect.get(current, 'nodes') as unknown;
    if (!Array.isArray(nodes))
      throw new TypeError('V2 executable control nodes are invalid');
    for (const value of nodes) {
      visited += 1;
      if (visited > 10_000)
        throw new RangeError(
          'Executable control node selection exceeds graph bound',
        );
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError('V2 executable control node is invalid');
      const nodeId = Reflect.get(value, 'id') as unknown;
      const definition = Reflect.get(value, 'definition') as unknown;
      if (
        typeof nodeId !== 'string' ||
        nodeId.length === 0 ||
        seen.has(nodeId) ||
        typeof definition !== 'object' ||
        definition === null ||
        Array.isArray(definition)
      )
        throw new TypeError('V2 executable control identity is invalid');
      const key = Reflect.get(definition, 'key') as unknown;
      const version = Reflect.get(definition, 'version') as unknown;
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version)
      )
        throw new TypeError('V2 executable control definition is invalid');
      seen.add(nodeId);
      if (workflowControlOutputKind({ key, version }) !== undefined)
        ids.add(nodeId);
      const structured = Reflect.get(value, 'structured') as unknown;
      if (structured === undefined) continue;
      if (
        typeof structured !== 'object' ||
        structured === null ||
        Array.isArray(structured)
      )
        throw new TypeError('V2 executable structured body is invalid');
      pending.push(Reflect.get(structured, 'body'));
    }
  }
  return ids;
}

/** Pinned compiled bounds only; this is not full executable/catalog admission. */
export function workflowForEachBoundsV2(executableJson: unknown): ReadonlyMap<
  string,
  Readonly<{
    maxIterations: number;
    maxConcurrency: number;
    ancestorLoopNodeIds: readonly string[];
  }>
> {
  // Reuse global identity/duplicate/node-count validation before selecting bounds.
  workflowControlOutputNodeIdsV2(executableJson);
  const bounds = new Map<
    string,
    Readonly<{
      maxIterations: number;
      maxConcurrency: number;
      ancestorLoopNodeIds: readonly string[];
    }>
  >();
  const pending = [
    {
      graph: Reflect.get(executableJson as object, 'graph') as object,
      ancestors: [] as readonly string[],
      depth: 0,
    },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > WORKFLOW_GRAPH_CONTRACT_LIMITS.structuredDepth)
      throw new RangeError('Executable For Each selection exceeds depth bound');
    const nodes = Reflect.get(current.graph, 'nodes') as readonly object[];
    for (const node of nodes) {
      const definition = Reflect.get(node, 'definition') as object;
      const version = Reflect.get(definition, 'version') as number;
      if (version < 1)
        throw new TypeError('V2 executable control definition is invalid');
      const structured = Reflect.get(node, 'structured') as object | undefined;
      // Retained unstructured foreach identities cannot prove a bounded rejection.
      if (structured === undefined) continue;
      if (
        workflowControlOutputKind({
          key: Reflect.get(definition, 'key') as string,
          version,
        }) !== 'for_each' ||
        Reflect.get(structured, 'kind') !== 'for_each'
      )
        throw new TypeError('V2 executable For Each structure is invalid');
      const maxIterations = Reflect.get(structured, 'maxIterations') as unknown;
      const maxConcurrency = Reflect.get(
        structured,
        'maxConcurrency',
      ) as unknown;
      if (
        typeof maxIterations !== 'number' ||
        !Number.isSafeInteger(maxIterations) ||
        maxIterations < 1 ||
        maxIterations > WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations ||
        typeof maxConcurrency !== 'number' ||
        !Number.isSafeInteger(maxConcurrency) ||
        maxConcurrency < 1 ||
        maxConcurrency > WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopConcurrency ||
        maxConcurrency > maxIterations
      )
        throw new TypeError('V2 executable For Each bounds are invalid');
      const nodeId = Reflect.get(node, 'id') as string;
      bounds.set(
        nodeId,
        Object.freeze({
          maxIterations,
          maxConcurrency,
          ancestorLoopNodeIds: Object.freeze([...current.ancestors]),
        }),
      );
      pending.push({
        graph: Reflect.get(structured, 'body') as object,
        ancestors: [...current.ancestors, nodeId],
        depth: current.depth + 1,
      });
    }
  }
  return bounds;
}
