import jsonata from 'jsonata';
import { isRecord, type ValueSource } from '@pertexo/workflow-model';
import { sourceFromExpression } from './sources';

type ObjectEntry = Readonly<{
  key: string;
  expression: string;
  source?: ValueSource;
}>;

/** What the server's expression policy accepts, checked again when it saves. */
export const EXPRESSION_BYTES_LIMIT = 16_384;

/** Use the existing parser's key positions; never interpret/evaluate expressions in the browser. */
export function objectExpressions(
  expression: string,
): readonly ObjectEntry[] | undefined {
  if (new TextEncoder().encode(expression).length > EXPRESSION_BYTES_LIMIT)
    return undefined;
  try {
    const ast: unknown = jsonata(expression).ast();
    if (!isObjectConstruction(ast, expression)) return undefined;
    const keys: { key: string; end: number; start: number }[] = [];
    for (const pair of ast.lhs) {
      if (!Array.isArray(pair)) return undefined;
      const key: unknown = pair[0];
      if (!isStringKey(key)) return undefined;
      const quoted = JSON.stringify(key.value);
      const start = key.position - quoted.length;
      // Noncanonical/dynamic keys stay editable as their original whole-object mapping.
      if (expression.slice(start, key.position) !== quoted) return undefined;
      keys.push({ key: key.value, end: key.position, start });
    }
    if (new Set(keys.map(({ key }) => key)).size !== keys.length)
      return undefined;
    return keys.map((key, index) => {
      const next = keys[index + 1];
      let source = expression
        .slice(key.end, next?.start ?? expression.lastIndexOf('}'))
        .replace(/^\s*:\s*/u, '')
        .replace(/,\s*$/u, '')
        .trim();
      let value: unknown = jsonata(source).ast();
      if (isSingleExpressionBlock(value, source)) {
        source = source.slice(1, -1).trim();
        value = value.expressions[0];
      }
      const mapping = sourceFromExpression(value, source);
      return {
        key: key.key,
        expression: source,
        ...(mapping === undefined ? {} : { source: mapping }),
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * A list of object constructions, `[{…}, {…}]`, as each object's entries.
 * Anything else, such as a path to a list, stays one whole mapping.
 */
export function listExpressions(
  expression: string,
): readonly (readonly ObjectEntry[])[] | undefined {
  if (new TextEncoder().encode(expression).length > EXPRESSION_BYTES_LIMIT)
    return undefined;
  try {
    const ast: unknown = jsonata(expression).ast();
    if (!isListConstruction(ast, expression)) return undefined;
    // An element's position is just past its opening brace.
    const starts = ast.expressions.map((element) =>
      isRecord(element) &&
      element.type === 'unary' &&
      element.value === '{' &&
      typeof element.position === 'number'
        ? element.position - 1
        : undefined,
    );
    if (starts.some((start) => start === undefined)) return undefined;
    const end = expression.lastIndexOf(']');
    const objects = starts.map((start, index) =>
      objectExpressions(
        expression
          .slice(start, starts[index + 1] ?? end)
          .trim()
          .replace(/,$/u, '')
          .trimEnd(),
      ),
    );
    return objects.every((entries) => entries !== undefined)
      ? objects
      : undefined;
  } catch {
    return undefined;
  }
}

function isListConstruction(
  ast: unknown,
  expression: string,
): ast is { type: 'unary'; value: '['; expressions: unknown[] } {
  return (
    isRecord(ast) &&
    ast.type === 'unary' &&
    ast.value === '[' &&
    Array.isArray(ast.expressions) &&
    expression.trimStart().startsWith('[') &&
    expression.trimEnd().at(-1) === ']'
  );
}

function isObjectConstruction(
  ast: unknown,
  expression: string,
): ast is { type: 'unary'; value: '{'; lhs: unknown[] } {
  return (
    isRecord(ast) &&
    ast.type === 'unary' &&
    ast.value === '{' &&
    Array.isArray(ast.lhs) &&
    expression.trimEnd().at(-1) === '}'
  );
}
function isStringKey(
  key: unknown,
): key is { type: 'string'; value: string; position: number } {
  return (
    isRecord(key) &&
    key.type === 'string' &&
    typeof key.value === 'string' &&
    typeof key.position === 'number'
  );
}
function isSingleExpressionBlock(
  value: unknown,
  source: string,
): value is { type: 'block'; expressions: unknown[] } {
  return (
    isRecord(value) &&
    value.type === 'block' &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 1 &&
    source.startsWith('(') &&
    source.endsWith(')')
  );
}
