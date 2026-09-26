import type {
  JsonValue as NodeJsonValue,
  NodeExecutionRequest,
  NodeExecutionResult,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import type { CompiledWorkflowExecutableV2 } from './executable-workflow.js';
import type { BranchScopePart, IterationScopePart } from './types.js';

// What one node attempt takes and gives back, shared by the engine's
// operations and the input preparation it delegates to.

export interface NodeExecutionRegistry {
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
  readonly dispatchMode?: (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ) => 'before_execute' | 'executor_controlled';
}

export interface ExecuteNodeAttemptInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
  readonly structuredCollection?: Readonly<{
    readonly loopNodeId: string;
    readonly ordinal: number;
    readonly collection: unknown;
    readonly collectionSize: number;
    readonly declaredCollectionChecksum: string;
  }>;
  readonly runInput: unknown;
  readonly completedNodeOutputs: unknown;
  readonly coordinatorInput?: unknown;
  readonly registry: NodeExecutionRegistry;
  readonly signal: AbortSignal;
  readonly runtime?: NodeExecutionRuntime;
  readonly expressionEvaluator?: ExpressionEvaluator;
  /**
   * Called once with the input the executor is about to receive, after
   * mappings resolve and before it runs (ADR 052). Recording it is the
   * caller's concern; the callback must not throw.
   */
  readonly onInputResolved?: (input: JsonValue) => Promise<void>;
}

export interface NodeAttemptOutcome {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly kind: NodeExecutionResult['kind'];
  readonly output: NodeJsonValue;
}
