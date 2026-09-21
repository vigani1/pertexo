import type { WorkflowGraph } from '../graph-contract.js';

const INPUT_MAPPING_ESCAPE_PREFIX = '\u0000pertexo.input-mapping.';
const INPUT_MAPPING_ESCAPED_PREFIX = `${INPUT_MAPPING_ESCAPE_PREFIX}escaped.`;
const INPUT_MAPPING_PROTO_KEY = `${INPUT_MAPPING_ESCAPE_PREFIX}proto`;

/**
 * Zod deliberately drops an own `__proto__` record key. Admission has already
 * snapshotted own data safely, so temporarily escape the affected mapping and
 * JSON-value keys (plus escape-prefix collisions) for structural parsing, then
 * restore them below.
 */
export function escapeDroppedInputMappingKeys(snapshot: unknown): unknown {
  return cloneGraphWithEscapedInputMappings(snapshot);
}

export function restoreDroppedInputMappingKeys(
  graph: WorkflowGraph,
): WorkflowGraph {
  visitGraphNodes(graph, (node) => {
    const config = Reflect.get(node, 'config');
    if (isObjectRecord(config))
      Reflect.set(node, 'config', restoreJsonValueKeys(config));

    const mappings = Reflect.get(node, 'inputMappings');
    if (!isObjectRecord(mappings)) return;
    const restored = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(mappings)) {
      const restoredKey = restoreKey(key);
      const source = Reflect.get(mappings, key);
      defineOwn(restored, restoredKey, restoreLiteralSource(source));
    }
    Reflect.set(node, 'inputMappings', restored);
  });
  return graph;
}

function visitGraphNodes(
  graph: unknown,
  visit: (node: Readonly<Record<string, unknown>>) => void,
): void {
  if (!isObjectRecord(graph)) return;
  const nodes = Reflect.get(graph, 'nodes');
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!isObjectRecord(node)) continue;
    visit(node);
    const structured = Reflect.get(node, 'structured');
    if (isObjectRecord(structured))
      visitGraphNodes(Reflect.get(structured, 'body'), visit);
  }
}

function cloneGraphWithEscapedInputMappings(graph: unknown): unknown {
  if (!isObjectRecord(graph)) return graph;
  const nodes = Reflect.get(graph, 'nodes');
  if (!Array.isArray(nodes)) return graph;

  const clonedGraph = cloneOwnData(graph);
  defineOwn(
    clonedGraph,
    'nodes',
    nodes.map((node) => cloneNodeWithEscapedInputMappings(node)),
  );
  return clonedGraph;
}

function cloneNodeWithEscapedInputMappings(node: unknown): unknown {
  if (!isObjectRecord(node)) return node;
  const clonedNode = cloneOwnData(node);
  const config = Reflect.get(node, 'config');
  if (isObjectRecord(config))
    defineOwn(clonedNode, 'config', escapeJsonValueKeys(config));
  const mappings = Reflect.get(node, 'inputMappings');
  if (isObjectRecord(mappings)) {
    const escaped = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(mappings)) {
      defineOwn(
        escaped,
        escapeKey(key),
        escapeLiteralSource(Reflect.get(mappings, key)),
      );
    }
    defineOwn(clonedNode, 'inputMappings', escaped);
  }

  const structured = Reflect.get(node, 'structured');
  if (isObjectRecord(structured)) {
    const clonedStructured = cloneOwnData(structured);
    defineOwn(
      clonedStructured,
      'body',
      cloneGraphWithEscapedInputMappings(Reflect.get(structured, 'body')),
    );
    defineOwn(clonedNode, 'structured', clonedStructured);
  }
  return clonedNode;
}

function escapeLiteralSource(source: unknown): unknown {
  if (!isObjectRecord(source) || Reflect.get(source, 'kind') !== 'literal')
    return source;
  const clone = cloneOwnData(source);
  defineOwn(clone, 'value', escapeJsonValueKeys(Reflect.get(source, 'value')));
  return clone;
}

function restoreLiteralSource(source: unknown): unknown {
  if (!isObjectRecord(source) || Reflect.get(source, 'kind') !== 'literal')
    return source;
  const clone = cloneOwnData(source);
  defineOwn(clone, 'value', restoreJsonValueKeys(Reflect.get(source, 'value')));
  return clone;
}

function escapeJsonValueKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(escapeJsonValueKeys);
  if (!isObjectRecord(value)) return value;
  const escaped = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value))
    defineOwn(
      escaped,
      escapeKey(key),
      escapeJsonValueKeys(Reflect.get(value, key)),
    );
  return escaped;
}

function restoreJsonValueKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreJsonValueKeys);
  if (!isObjectRecord(value)) return value;
  const restored = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value))
    defineOwn(
      restored,
      restoreKey(key),
      restoreJsonValueKeys(Reflect.get(value, key)),
    );
  return restored;
}

function escapeKey(key: string): string {
  if (key === '__proto__') return INPUT_MAPPING_PROTO_KEY;
  return key.startsWith(INPUT_MAPPING_ESCAPE_PREFIX)
    ? `${INPUT_MAPPING_ESCAPED_PREFIX}${key}`
    : key;
}

function restoreKey(key: string): string {
  if (key === INPUT_MAPPING_PROTO_KEY) return '__proto__';
  return key.startsWith(INPUT_MAPPING_ESCAPED_PREFIX)
    ? key.slice(INPUT_MAPPING_ESCAPED_PREFIX.length)
    : key;
}

function cloneOwnData(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const clone = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source))
    defineOwn(clone, key, Reflect.get(source, key));
  return clone;
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isObjectRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
