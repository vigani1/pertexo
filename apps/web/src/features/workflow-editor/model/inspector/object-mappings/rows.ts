import {
  isRecord,
  canonicalJson,
  type ValueSource,
} from '@pertexo/workflow-model';
import type { InputMappingDraftRow } from '../input-mappings/draft';
import { inputMappingRowsFor } from '../input-mappings/draft';
import { objectExpressions } from './expressions';
import { valueExpression } from './sources';

export function contextRows(
  source: ValueSource | undefined,
): readonly InputMappingDraftRow[] | undefined {
  if (source === undefined) return [];
  if (source.kind === 'literal' && isRecord(source.value))
    return inputMappingRowsFor(
      Object.fromEntries(
        Object.entries(source.value).map(([key, value]) => [
          key,
          { kind: 'literal' as const, value },
        ]),
      ),
    );
  if (source.kind !== 'expression') return undefined;
  const entries = objectExpressions(source.expression);
  return entries?.map(({ key, expression, source }, index) => {
    const base = { id: `context-${String(index)}`, destinationKey: key };
    if (source !== undefined) {
      const row = inputMappingRowsFor({ [key]: source })[0];
      if (row !== undefined) return { ...row, ...base };
    }
    try {
      const value: unknown = JSON.parse(expression);
      return {
        ...base,
        kind: 'literal' as const,
        literalJson: canonicalJson(value),
      };
    } catch {
      return { ...base, kind: 'expression' as const, expression };
    }
  });
}
export function contextMapping(
  mappings: Readonly<Record<string, ValueSource>>,
): ValueSource | undefined {
  const entries = Object.entries(mappings);
  if (entries.every(([, source]) => source.kind === 'literal'))
    return {
      kind: 'literal',
      value: Object.fromEntries(
        entries.map(([key, source]) => [
          key,
          source.kind === 'literal' ? source.value : null,
        ]),
      ),
    };
  const expressions: string[] = [];
  for (const [key, source] of entries) {
    const value = valueExpression(source);
    if (value === undefined) return undefined;
    expressions.push(`  ${JSON.stringify(key)}: (${value})`);
  }
  return {
    kind: 'expression',
    language: 'jsonata',
    expression: `{\n${expressions.join(',\n')}\n}`,
  };
}
