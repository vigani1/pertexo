import type {
  NodeDataTableRuntime,
  NodeRunValuesRuntime,
} from '@pertexo/node-sdk';
import type { NodeCodeRuntime, JsonValue } from '@pertexo/node-sdk/server';
import type {
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeWebhookResponseRuntime,
} from '@pertexo/node-sdk/server';

/** Identity and ownership supplied when constructing per-attempt capabilities. */
export type NodeExecutionCapabilityContext = Readonly<{
  artifactRetentionDeadline?: Date;
  deadlineAt?: Date;
  testRun?: boolean;
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
  runValues?: (
    context: NodeExecutionCapabilityContext & Readonly<{ fenceToken: number }>,
  ) => NodeRunValuesRuntime;
  dataTables?: (
    context: NodeExecutionCapabilityContext & Readonly<{ fenceToken: number }>,
  ) => NodeDataTableRuntime;
  code?: (
    context: NodeExecutionCapabilityContext &
      Readonly<{ variables: Readonly<Record<string, JsonValue>> }>,
  ) => NodeCodeRuntime;
  connections?: (
    context: NodeExecutionCapabilityContext,
  ) => NodeConnectionRuntime;
  artifacts?: (context: NodeExecutionCapabilityContext) => NodeArtifactRuntime;
  webhookResponse?: (
    context: NodeExecutionCapabilityContext & Readonly<{ fenceToken: number }>,
  ) => NodeWebhookResponseRuntime;
}>;
