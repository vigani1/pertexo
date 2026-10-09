import type {
  NodeArtifactRuntime,
  NodeConnectionRuntime,
} from '@pertexo/node-sdk/server';

/** Identity and ownership supplied when constructing per-attempt capabilities. */
export type NodeExecutionCapabilityContext = Readonly<{
  artifactRetentionDeadline?: Date;
  previewRunId?: string;
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  nodeId: string;
  invocationKey: string;
  workerId: string;
}>;

/** Per-attempt factories shared by production and preview execution modes. */
export type NodeExecutionCapabilityFactories = Readonly<{
  connections?: (
    context: NodeExecutionCapabilityContext,
  ) => NodeConnectionRuntime;
  artifacts?: (context: NodeExecutionCapabilityContext) => NodeArtifactRuntime;
}>;
