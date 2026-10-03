import { workflowAuthoringGraphSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import type { InputMapping as ValueSource } from './input-mappings';
import {
  callableDeclaration,
  emptyCallableDeclaration,
} from '../graph/callable-contract';
import type { FieldParseResult } from './inspector-draft';

export function formatCallableResultSource(value: ValueSource): string {
  return JSON.stringify(value, null, 2);
}

export function equalCallableResultSources(
  left: ValueSource,
  right: ValueSource,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Shared admission preserves bounded literals, including own data keys. */
export function parseCallableResultSourceText(
  text: string,
): FieldParseResult<ValueSource> {
  let resultSelector: unknown;
  try {
    resultSelector = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      error: 'That isn’t valid JSON yet. Check for a missing quote or brace.',
    };
  }
  const result = workflowAuthoringGraphSchema.safeParse({
    schemaVersion: 2,
    nodes: [],
    edges: [],
    settings: {},
    callable: { ...emptyCallableDeclaration(), resultSelector },
  });
  const source = result.success
    ? callableDeclaration(result.data)?.resultSelector
    : undefined;
  return source === undefined
    ? {
        ok: false,
        error:
          'Use a supported value source with its required fields. Runtime validation checks scope and the result type.',
      }
    : { ok: true, value: source };
}
