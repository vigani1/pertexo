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

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type GraphLevel = Readonly<{ nodes: readonly WorkflowNode[] }>;

const BODY_SEGMENT = 'structured.body';

/**
 * The step (and field) an issue is about. Steps inside a For each body are
 * found through their body's path, `$.nodes.loop.structured.body.nodes.…`,
 * so Fix opens the body step itself.
 */
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
  return targetIn(graph, '$', issue.path);
}

function targetIn(
  level: GraphLevel,
  prefix: string,
  path: string,
): WorkflowValidationTarget | undefined {
  for (const node of level.nodes) {
    const nodePrefix = `${prefix}.nodes.${node.id}`;
    if (path !== nodePrefix && !path.startsWith(`${nodePrefix}.`)) continue;
    const remainder =
      path === nodePrefix ? undefined : path.slice(nodePrefix.length + 1);
    const body = node.structured?.body;
    const inBody =
      body !== undefined && remainder?.startsWith(`${BODY_SEGMENT}.`) === true
        ? targetIn(body, `${nodePrefix}.${BODY_SEGMENT}`, path)
        : undefined;
    return inBody ?? targetForRemainder(node.id, remainder);
  }
  return undefined;
}

export function resolveWorkflowCompatibilityTarget(
  issue: WorkflowCompatibilityIssue,
  graph: WorkflowGraphContract,
): WorkflowValidationTarget | undefined {
  const node = everyStep(graph).find(
    (candidate) =>
      candidate.definition.key === issue.definitionKey &&
      candidate.definition.version === issue.version,
  );
  return node === undefined ? undefined : { nodeId: node.id };
}

/** A step anywhere in the workflow, inside For each bodies too. */
export function findWorkflowStep(
  graph: WorkflowGraphContract,
  nodeId: string,
): WorkflowNode | undefined {
  return everyStep(graph).find((node) => node.id === nodeId);
}

function everyStep(level: GraphLevel): readonly WorkflowNode[] {
  return level.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined ? [] : everyStep(node.structured.body)),
  ]);
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
