import type { ValueSource } from '@pertexo/workflow-model';

export type ResultDraft =
  | Readonly<{ kind: 'workspace_variable'; name: string }>
  | Readonly<{ kind: 'literal'; json: string }>
  | Readonly<{ kind: 'run_input'; path: string }>
  | Readonly<{ kind: 'node_output'; nodeId: string; path: string }>
  | Readonly<{ kind: 'expression'; expression: string }>;

export function editResult(result: ValueSource): ResultDraft {
  switch (result.kind) {
    case 'literal':
      return { kind: 'literal', json: JSON.stringify(result.value, null, 2) };
    case 'workspace_variable':
    case 'run_input':
    case 'node_output':
    case 'expression':
      return result;
    case 'node_failure':
      throw new Error('A workflow result cannot read failure data.');
    case 'structured_input':
      // The model rejects body ports for a workflow-level result.
      throw new Error('A workflow result cannot read a structured input port.');
  }
}

/** Parsed JSON is validated together with the graph at the Apply boundary. */
export function declaredResult(result: ResultDraft): unknown {
  if (result.kind === 'literal') {
    return { kind: 'literal', value: JSON.parse(result.json) as unknown };
  }
  if (result.kind === 'expression') {
    return { ...result, language: 'jsonata' };
  }
  return result;
}

export function emptyResult(kind: ResultDraft['kind']): ResultDraft {
  switch (kind) {
    case 'workspace_variable':
      return { kind, name: '' };
    case 'literal':
      return { kind, json: 'null' };
    case 'run_input':
      return { kind, path: '$' };
    case 'node_output':
      return { kind, nodeId: '', path: '$' };
    case 'expression':
      return { kind, expression: 'runInput' };
  }
}
