import jsonata from 'jsonata';
import { isRecord, type ValueSource } from '@pertexo/workflow-model';
import { sourceFromExpression } from './sources';

/** Use the existing parser's key positions; never interpret/evaluate expressions in the browser. */
export function objectExpressions(expression: string):
  | readonly Readonly<{
      key: string;
      expression: string;
      source?: ValueSource;
    }>[]
  | undefined {
  if (new TextEncoder().encode(expression).length > 16384) return undefined;
  try {
    const ast: unknown = jsonata(expression).ast();
    if (
      !isRecord(ast) ||
      ast.type !== 'unary' ||
      ast.value !== '{' ||
      !Array.isArray(ast.lhs) ||
      expression.trimEnd().at(-1) !== '}'
    )
      return undefined;
    const keys: { key: string; end: number; start: number }[] = [];
    for (const pair of ast.lhs) {
      if (!Array.isArray(pair)) return undefined;
      const key: unknown = pair[0];
      if (
        !isRecord(key) ||
        key.type !== 'string' ||
        typeof key.value !== 'string' ||
        typeof key.position !== 'number'
      )
        return undefined;
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
      if (
        isRecord(value) &&
        value.type === 'block' &&
        Array.isArray(value.expressions) &&
        value.expressions.length === 1 &&
        source.startsWith('(') &&
        source.endsWith(')')
      ) {
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
