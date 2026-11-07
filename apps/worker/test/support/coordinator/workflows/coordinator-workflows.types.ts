export type Query = (
  statement: string,
  parameters?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface WorkflowIdentity {
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export type EdgeTuple = readonly [
  id: string,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
];

export interface CoordinatorWorkflowFixtureIdentities {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly retained: WorkflowIdentity;
  readonly condition: WorkflowIdentity;
  readonly forEach: WorkflowIdentity;
  readonly nestedParallel: WorkflowIdentity;
  readonly parallel: WorkflowIdentity;
  readonly switch: WorkflowIdentity;
  readonly wait: WorkflowIdentity;
}

export type StructuredForEachKind = 'condition' | 'switch' | 'nested';
