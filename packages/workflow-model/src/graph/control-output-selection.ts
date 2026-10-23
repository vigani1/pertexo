import { isRecord } from '../values/json/object.js';
import { isCallbackWaitNode } from '../flow/callbacks/contract.js';
export type WorkflowControlOutputKind =
  'branch' | 'parallel' | 'for_each' | 'human_task';

/** Definition identity, not output property names, determines control materialization. */
export function workflowControlOutputKind(
  definition: Readonly<{ key: string; version: number }> | undefined,
  config?: Readonly<Record<string, unknown>>,
): WorkflowControlOutputKind | undefined {
  if (definition?.version !== 1) return undefined;
  if (
    definition.key === 'core.condition' ||
    definition.key === 'core.switch' ||
    definition.key === 'core.approval'
  )
    return 'branch';
  if (
    definition.key === 'core.request_input' ||
    isCallbackWaitNode({
      definition,
      ...(config === undefined ? {} : { config }),
    })
  )
    return 'human_task';
  if (definition.key === 'core.foreach') return 'for_each';
  if (definition.key === 'core.parallel') return 'parallel';
  return undefined;
}

/** Selects node IDs from the immutable compiled envelope. */
export function workflowControlOutputNodeIds(
  executableJson: unknown,
): ReadonlySet<string> {
  if (
    typeof executableJson !== 'object' ||
    executableJson === null ||
    Array.isArray(executableJson)
  )
    throw new TypeError('Executable control metadata is invalid');
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
      throw new TypeError('Executable control graph is invalid');
    const nodes = Reflect.get(current, 'nodes') as unknown;
    if (!Array.isArray(nodes))
      throw new TypeError('Executable control nodes are invalid');
    for (const value of nodes) {
      visited += 1;
      if (visited > 10_000)
        throw new RangeError(
          'Executable control node selection exceeds graph bound',
        );
      selectControlNode(value, seen, ids, pending);
    }
  }
  return ids;
}

function selectControlNode(
  value: unknown,
  seen: Set<string>,
  ids: Set<string>,
  pending: unknown[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Executable control node is invalid');
  const nodeId = Reflect.get(value, 'id') as unknown;
  const definition = Reflect.get(value, 'definition') as unknown;
  const invalidIdentity =
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    seen.has(nodeId) ||
    typeof definition !== 'object' ||
    definition === null ||
    Array.isArray(definition);
  if (invalidIdentity)
    throw new TypeError('Executable control identity is invalid');
  const key = Reflect.get(definition, 'key') as unknown;
  const version = Reflect.get(definition, 'version') as unknown;
  const invalidDefinition =
    typeof key !== 'string' ||
    key.length === 0 ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version);
  if (invalidDefinition)
    throw new TypeError('Executable control definition is invalid');
  seen.add(nodeId);
  const config: unknown = Reflect.get(value, 'config');
  if (
    workflowControlOutputKind(
      { key, version },
      isRecord(config) ? config : undefined,
    ) !== undefined
  )
    ids.add(nodeId);
  const structured = Reflect.get(value, 'structured') as unknown;
  if (structured === undefined) return;
  if (
    typeof structured !== 'object' ||
    structured === null ||
    Array.isArray(structured)
  )
    throw new TypeError('Executable structured body is invalid');
  pending.push(Reflect.get(structured, 'body'));
}
