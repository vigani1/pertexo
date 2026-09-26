import { stepTitle } from './graph-adapter';
import type { GraphLevel } from './graph-scopes';
import type { InputMappingDraftRow } from './input-mappings';

/**
 * How a source chip reads: references to data elsewhere (a step's output,
 * the run input, the loop item), code, a fixed value, or a source that
 * isn't chosen yet.
 */
export type MappingSourceTone = 'reference' | 'code' | 'value' | 'missing';

export type MappingSourceSummary = Readonly<{
  tone: MappingSourceTone;
  /** "New invoice › body.amount", "Run input", "ƒ expression", "“Paid”". */
  label: string;
  /** An expression's code, shown under the row. */
  code?: string;
}>;

const LITERAL_LABEL_LIMIT = 40;

const loopPortWords: Readonly<Record<string, string>> = {
  item: 'This item',
  ordinal: 'Its position',
};

/**
 * The source half of a `field ← source` row in a few words. Paths lose
 * their `$` root ("$.body.amount" reads "body.amount"); the whole value is
 * just its owner's name.
 */
export function describeMappingSource(
  row: InputMappingDraftRow,
  graph: GraphLevel,
): MappingSourceSummary {
  switch (row.kind) {
    case 'literal':
      return describeLiteral(row.literalJson);
    case 'expression':
      return row.expression.trim() === ''
        ? { tone: 'missing', label: 'ƒ expression' }
        : { tone: 'code', label: 'ƒ expression', code: row.expression };
    case 'run_input':
      return { tone: 'reference', label: pathLabel('Run input', row.path) };
    case 'structured_input':
      return {
        tone: 'reference',
        label: pathLabel(loopPortWords[row.port] ?? row.port, row.path),
      };
    case 'node_output': {
      if (row.nodeId === '') return { tone: 'missing', label: 'Choose a step' };
      const source = graph.nodes.find((node) => node.id === row.nodeId);
      return source === undefined
        ? { tone: 'missing', label: 'A missing step' }
        : { tone: 'reference', label: pathLabel(stepTitle(source), row.path) };
    }
  }
}

function pathLabel(owner: string, path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '$') return owner;
  const part = trimmed.startsWith('$.')
    ? trimmed.slice(2)
    : trimmed.startsWith('$')
      ? trimmed.slice(1)
      : trimmed;
  return `${owner} › ${part}`;
}

/** A fixed value as it reads: “text”, 42, true, no value, {3 fields}, [2 items]. */
function describeLiteral(json: string): MappingSourceSummary {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { tone: 'missing', label: 'Unfinished value' };
  }
  // null is what a new row holds: in words it's "no value", not a token
  // that reads like something was typed.
  if (value === null) return { tone: 'value', label: 'no value' };
  if (typeof value === 'string')
    return { tone: 'value', label: `“${clip(value)}”` };
  if (Array.isArray(value))
    return {
      tone: 'value',
      label: `[${String(value.length)} ${value.length === 1 ? 'item' : 'items'}]`,
    };
  if (typeof value === 'object') {
    const count = Object.keys(value).length;
    return {
      tone: 'value',
      label: `{${String(count)} ${count === 1 ? 'field' : 'fields'}}`,
    };
  }
  return { tone: 'value', label: clip(JSON.stringify(value)) };
}

function clip(text: string): string {
  return text.length > LITERAL_LABEL_LIMIT
    ? `${text.slice(0, LITERAL_LABEL_LIMIT - 1)}…`
    : text;
}
