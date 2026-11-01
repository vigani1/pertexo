import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
} from '@pertexo/core/attempts';
import type {
  WorkflowExecutionReader,
  WorkflowExecutionProjection,
} from '@pertexo/core/runs';
import type {
  ForEachUpstream,
  NodeAttemptInputs,
} from '@pertexo/core/execution';

import type {
  QueueDelivery,
  QueueHandlerContext,
  RunEventNotificationPublisher,
} from '@pertexo/queue';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';

import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';

import type { NodeExecutionCapabilityFactories } from '../execution/capabilities.js';

export type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
  readonly sourceFailure?: Readonly<{ nodeId: string; invocationKey: string }>;
  readonly suspensionDurationSeconds?: number;
  readonly testSubstitution?: boolean;
  readonly testPinRequired?: boolean;
  readonly upstreamNodeOutputs: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
  }>[];
  /** The upstream For Each steps whose results the attempt receives. */
  readonly forEachUpstreams?: readonly ForEachUpstream[];
  execute(
    input: Readonly<
      NodeAttemptInputs & {
        registry: NodeExecutionRegistry;
        runtime?: NodeExecutionRuntime;
        signal: AbortSignal;
        onInputResolved?: ExecuteNodeAttemptInput['onInputResolved'];
      }
    >,
  ): Promise<NodeAttemptOutcome>;
}

export interface NodeAttemptExecutionEngine {
  prepare(
    input: Readonly<{
      lease: NodeAttemptLease;
      projection: WorkflowExecutionProjection;
    }>,
  ): PreparedNodeAttempt;
}

export type NodeAttemptHandlerResult = Readonly<{
  kind: 'duplicate' | 'committed';
}>;

export interface NodeAttemptHandler {
  handle(
    delivery: AttemptDelivery,
    context: QueueHandlerContext,
  ): Promise<NodeAttemptHandlerResult>;
}

export type NodeAttemptHandlerDependencies = Readonly<{
  engine: NodeAttemptExecutionEngine;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  notifications?: RunEventNotificationPublisher;
  reader: WorkflowExecutionReader;
  registry: NodeExecutionRegistry;
  runStore: NodeAttemptRunStore;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
  workerId: string;
}>;

export type HeartbeatFailure =
  Readonly<{ failed: false }> | Readonly<{ error: unknown; failed: true }>;

export type NodeAttemptHeartbeat = Readonly<{
  executionSignal: AbortSignal;
  durableAbortReason(): 'canceled' | 'timed_out' | undefined;
  failure(): HeartbeatFailure;
  stop(): Promise<void>;
}>;
