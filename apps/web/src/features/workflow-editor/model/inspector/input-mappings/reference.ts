import { pathExpression, valueExpression } from '../object-mappings/sources';

/** A value Insert data hands to the row or rule it was opened for. */
export type InsertedSource =
  | Readonly<{ kind: 'expression'; expression: string }>
  | Readonly<{ kind: 'workspace_variable'; name: string }>
  | Readonly<{ kind: 'node_failure'; nodeId: string; path: string }>
  | Readonly<{ kind: 'node_output'; nodeId: string; path: string }>
  | Readonly<{ kind: 'run_input'; path: string }>
  | Readonly<{ kind: 'structured_input'; port: string; path: string }>;

/**
 * The JSONata that reads a source, for an expression or a Condition rule; a
 * failure's safe fields aren't in an expression's context, so they have none.
 */
export function sourceReference(source: InsertedSource): string | undefined {
  switch (source.kind) {
    case 'expression':
      return source.expression;
    case 'structured_input':
      return pathExpression(`loop.${source.port}`, source.path);
    case 'node_failure':
      return undefined;
    case 'node_output':
    case 'run_input':
    case 'workspace_variable':
      return valueExpression(source);
  }
}

const NAME = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const SEGMENTS = String.raw`(?:\.${NAME}|\[\d+\])*`;
const ROOT = String.raw`runInput|nodeOutputs\.${NAME}|loop\.[A-Za-z_][A-Za-z0-9_]*`;

/** Just the references `sourceReference` writes, so nothing else reads as one. */
export const REFERENCE_PATTERN = String.raw`(?:(?:${ROOT})${SEGMENTS}|\$vars\.[A-Z][A-Z0-9_]*)`;

const READABLE = new RegExp(
  `^(${ROOT}|\\$vars\\.[A-Z][A-Z0-9_]*)(${SEGMENTS})$`,
  'u',
);

export type ReadReference = Readonly<{
  origin:
    | Readonly<{ kind: 'run_input' }>
    | Readonly<{ kind: 'node_output'; nodeId: string }>
    | Readonly<{ kind: 'loop'; port: string }>
    | Readonly<{ kind: 'workspace_variable'; name: string }>;
  /** The field in words, `items[0].id`; empty for the whole value. */
  field: string;
}>;

/** What a reference reads, to name it in words. */
export function readReference(reference: string): ReadReference | undefined {
  const match = READABLE.exec(reference);
  const root = match?.[1];
  if (root === undefined) return undefined;
  const field = readableField(match?.[2] ?? '');
  if (root === 'runInput') return { origin: { kind: 'run_input' }, field };
  if (root.startsWith('$vars.'))
    return {
      origin: { kind: 'workspace_variable', name: root.slice('$vars.'.length) },
      field,
    };
  if (root.startsWith('loop.'))
    return {
      origin: { kind: 'loop', port: root.slice('loop.'.length) },
      field,
    };
  return {
    origin: {
      kind: 'node_output',
      nodeId: JSON.parse(root.slice('nodeOutputs.'.length)) as string,
    },
    field,
  };
}

function readableField(segments: string): string {
  let field = '';
  for (const [segment] of segments.matchAll(
    new RegExp(String.raw`\.${NAME}|\[\d+\]`, 'gu'),
  ))
    field += segment.startsWith('[')
      ? segment
      : `${field === '' ? '' : '.'}${JSON.parse(segment.slice(1)) as string}`;
  return field;
}
