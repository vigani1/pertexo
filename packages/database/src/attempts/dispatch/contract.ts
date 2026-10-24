export type ExecutionCapabilityScope = Readonly<{
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  workerId: string;
  fenceToken: number;
  previewRunId?: string;
  nodeId: string;
  invocationKey: string;
}>;
