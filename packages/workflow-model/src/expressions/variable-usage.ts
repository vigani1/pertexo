import type { WorkflowGraph, ValueSource } from '../graph/contract.js';
import { inspectExpression, EXPRESSION_POLICY } from './policy.js';
export type WorkflowVariableReference = Readonly<{
  nodeId: string | null;
  label: string;
  input: string;
  names: readonly string[];
  dynamic: boolean;
}>;
export type WorkflowVariableSource = Readonly<{
  nodeId: string | null;
  label: string;
  input: string;
  source: Extract<ValueSource, { kind: 'expression' | 'workspace_variable' }>;
  costBytes: number;
}>;
function sourceEntry(
  source: ValueSource,
  nodeId: string | null,
  label: string,
  input: string,
): WorkflowVariableSource | undefined {
  if (source.kind !== 'expression' && source.kind !== 'workspace_variable')
    return undefined;
  return {
    source,
    nodeId,
    label: label.slice(0, 160),
    input: input.slice(0, 128),
    costBytes:
      source.kind === 'expression'
        ? Math.min(
            Buffer.byteLength(source.expression),
            EXPRESSION_POLICY.expressionBytes + 1,
          )
        : source.name.length,
  };
}
/** Enumerate cheaply; the caller bounds how many expressions it parses in one request. */
export function* workflowVariableSources(
  graph: WorkflowGraph,
): Generator<WorkflowVariableSource> {
  if (graph.callable !== undefined) {
    const entry = sourceEntry(
      graph.callable.result,
      null,
      'Workflow result',
      'result',
    );
    if (entry !== undefined) yield entry;
  }
  for (const node of graph.nodes) {
    for (const [key, source] of Object.entries(node.inputMappings)) {
      const entry = sourceEntry(source, node.id, node.label ?? node.id, key);
      if (entry !== undefined) yield entry;
    }
    if (node.structured !== undefined)
      yield* workflowVariableSources(node.structured.body);
  }
}
export function inspectWorkflowVariableSource(
  entry: WorkflowVariableSource,
): Readonly<{
  reference: WorkflowVariableReference | null;
  incomplete: boolean;
}> {
  const { source, nodeId, label, input } = entry;
  if (source.kind === 'workspace_variable')
    return {
      reference: { nodeId, label, input, names: [source.name], dynamic: false },
      incomplete: false,
    };
  const inspected = inspectExpression(source.expression);
  if (inspected.kind === 'error') return { reference: null, incomplete: true };
  const { names, dynamic } = inspected.references;
  return {
    reference:
      names.length || dynamic ? { nodeId, label, input, names, dynamic } : null,
    incomplete: false,
  };
}
