import type {
  WorkflowGraphContract,
  WorkflowValidateResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';

export type WorkflowValidationIssue =
  WorkflowValidateResponse['issues'][number];
export type WorkflowCompatibilityIssue =
  WorkflowValidateResponse['compatibility']['issues'][number];

export type WorkflowValidationTarget = Readonly<{
  nodeId: string;
  fieldKey?: string;
  mappingKey?: string;
}>;

export function resolveWorkflowValidationTarget(
  issue: WorkflowValidationIssue,
  graph: WorkflowGraphContract,
): WorkflowValidationTarget | undefined {
  const indexed = /^\$\.nodes\[(\d+)\](?:\.(.*))?$/u.exec(issue.path);
  if (indexed !== null) {
    const node = graph.nodes[Number(indexed[1])];
    return node === undefined
      ? undefined
      : targetForRemainder(node.id, indexed[2]);
  }

  for (const node of graph.nodes) {
    const prefix = `$.nodes.${node.id}`;
    if (issue.path !== prefix && !issue.path.startsWith(`${prefix}.`)) continue;
    return targetForRemainder(
      node.id,
      issue.path === prefix ? undefined : issue.path.slice(prefix.length + 1),
    );
  }
  return undefined;
}

export function resolveWorkflowCompatibilityTarget(
  issue: WorkflowCompatibilityIssue,
  graph: WorkflowGraphContract,
): WorkflowValidationTarget | undefined {
  const node = graph.nodes.find(
    (candidate) =>
      candidate.definition.key === issue.definitionKey &&
      candidate.definition.version === issue.version,
  );
  return node === undefined ? undefined : { nodeId: node.id };
}

function targetForRemainder(
  nodeId: string,
  remainder: string | undefined,
): WorkflowValidationTarget {
  const configField = /^config\.([^.[]+)/u.exec(remainder ?? '')?.[1];
  if (configField !== undefined) return { nodeId, fieldKey: configField };
  const mappingKey = /^inputMappings\.(.+)$/u.exec(remainder ?? '')?.[1];
  return mappingKey === undefined ? { nodeId } : { nodeId, mappingKey };
}
