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
export function workflowControlOutputNodeIds(
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
