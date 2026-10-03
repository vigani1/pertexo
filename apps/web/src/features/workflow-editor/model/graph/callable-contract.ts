import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

export function callableDeclaration(graph: WorkflowGraphContract) {
  return 'callable' in graph ? graph.callable : undefined;
}

export type CallableDeclaration = NonNullable<
  ReturnType<typeof callableDeclaration>
>;

export function emptyCallableDeclaration(): CallableDeclaration {
  return {
    schemaVersion: 1,
    input: { type: 'object', properties: {}, required: [] },
    result: { type: 'object', properties: {}, required: [] },
    resultSelector: { kind: 'literal', value: {} },
  };
}

/** Removing a declaration never downgrades native nodes or nested bodies. */
export function setCallableDeclaration(
  graph: WorkflowGraphContract,
  declaration: CallableDeclaration | undefined,
): WorkflowGraphContract {
  if (callableDeclaration(graph) === declaration) return graph;
  if (declaration === undefined) {
    const { callable: _removed, ...native } = { ...graph, callable: undefined };
    return native;
  }
  return { ...graph, schemaVersion: 2, callable: declaration };
}
