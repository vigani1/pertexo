export type CoordinatorExecutionIdentity = Readonly<{
  nodeRunId: string;
  attemptId?: string;
  attemptNumber?: number;
}>;

export type ExecutionIdentityMap = Map<string, CoordinatorExecutionIdentity>;
