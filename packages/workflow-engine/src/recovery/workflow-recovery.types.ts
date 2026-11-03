import type {
  NodeExecutorErrorKind,
  NodeExecutorFailureOutcome,
} from '@pertexo/node-sdk/server';
import type {
  JsonValue,
  WorkflowRecoveryEffectRisk,
  WorkflowRecoveryRefusal,
} from '@pertexo/workflow-model';
import type {
  CompiledWorkflowExecutable,
  WorkflowExecutableNode,
} from '../compilation/foundation.js';
import type {
  BranchScopePart,
  BranchSelection,
  InvocationState,
  IterationScopePart,
  NodeStatus,
  RunStatus,
  SideEffectClass,
  WorkflowCheckpoint,
} from '../types.js';

export interface RecoveryAttempt {
  readonly id: string;
  readonly number: number;
  readonly status: NodeStatus;
  readonly failureKind: NodeExecutorFailureOutcome['kind'] | null;
  readonly errorKind: NodeExecutorErrorKind | null;
  readonly possiblyDispatched: boolean | null;
  readonly dispatchMarked: boolean;
  readonly retryDecision: string | null;
}

export interface RecoveryNode {
  readonly id: string;
  readonly nodeId: string;
  readonly invocationKey: string;
  readonly status: NodeStatus;
  readonly sideEffectClass: SideEffectClass;
  readonly currentAttemptId: string | null;
  readonly currentAttemptNumber: number | null;
  readonly completedAt: string | null;
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
  readonly reused?: Readonly<{
    sourceRunId: string;
    sourceNodeRunId: string;
    completedAt: string;
  }>;
  readonly attempts: readonly RecoveryAttempt[];
}

export interface RecoverySource {
  readonly id: string;
  readonly workflowVersionId: string;
  readonly status: RunStatus;
  readonly completedAt: string | null;
  readonly checkpoint: WorkflowCheckpoint;
  readonly nodes: readonly RecoveryNode[];
}

export type RecoveryRefused = Readonly<{
  kind: 'refused';
  reason: WorkflowRecoveryRefusal;
}>;

export interface RecoveryPrefixNode {
  readonly source: RecoveryNode;
  readonly invocation: InvocationState;
  readonly definition: WorkflowExecutableNode;
}

export interface RecoveryCandidate {
  readonly kind: 'candidate';
  readonly source: RecoverySource;
  readonly executable: CompiledWorkflowExecutable;
  readonly target: RecoveryNode;
  readonly prefix: readonly RecoveryPrefixNode[];
  readonly branchSelections: readonly BranchSelection[];
  readonly effectRisk: WorkflowRecoveryEffectRisk;
}

export interface RecoveryValues {
  readonly input:
    | Readonly<{ kind: 'inline'; value: JsonValue }>
    | Readonly<{ kind: 'none' | 'expired' | 'artifact' }>;
  readonly outputs: ReadonlyMap<
    string,
    Readonly<{
      node:
        | Readonly<{ kind: 'inline'; value: JsonValue }>
        | Readonly<{ kind: 'artifact' }>
        | undefined;
      attempt:
        | Readonly<{ kind: 'inline'; value: JsonValue }>
        | Readonly<{ kind: 'artifact' }>
        | undefined;
    }>
  >;
}

export interface RecoveryPlan extends Omit<RecoveryCandidate, 'kind'> {
  readonly kind: 'eligible';
  readonly input: JsonValue | undefined;
  readonly outputs: ReadonlyMap<string, JsonValue>;
}
