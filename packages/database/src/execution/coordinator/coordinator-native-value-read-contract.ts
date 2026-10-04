import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { CallableValueWorkStop } from '@pertexo/workflow-model/workflow-call-contract';
import type { PersistedWorkflowCheckpointV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import type { NativeNodeAttemptValueSource } from '../node-attempts/native-node-attempt-value-sources.js';
import type { StoredExecutionValueV1 } from '../stored-execution-value.js';
import type { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../artifacts/execution-value-representation.js';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import type { NativeCoordinatorCallDeclarationSource } from './coordinator-call-declaration-source.js';

type Output = NonNullable<
  PersistedWorkflowCheckpointV3['invocations'][number]['output']
>;

export type NativeCoordinatorValueOwner = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  delivery: CoordinatorAdvanceDelivery;
  expectedRevision: number;
}>;

/** Structurally matches the engine demand; database never imports the engine. */
export type NativeCoordinatorMaterialDemand = Readonly<{
  expectedRevision: number;
  resultSelector: WorkflowCallableDeclarationV1['resultSelector'];
  requiresRunInput: boolean;
  sources: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
    output: Output;
  }>[];
}>;

export type NativeCallableValueIdentity = Readonly<{
  reference:
    | Pick<
        Extract<StoredExecutionValueV1, { kind: 'inline' }>,
        'schemaVersion' | 'kind'
      >
    | Extract<StoredExecutionValueV1, { kind: 'artifact' }>;
  sha256: string;
  byteLength: number;
  mediaType: typeof WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1;
}>;

/** Accepted identity only: no inline value, original bytes, buffer or locator. */
export type NativeCallableValueDescriptor =
  | Readonly<{
      slot: 'run_input';
      source: Extract<
        NativeNodeAttemptValueSource,
        { slot: 'run_input' }
      >['source'];
      valueIdentity: NativeCallableValueIdentity;
    }>
  | Readonly<{
      slot: 'upstream_output';
      source: Extract<
        NativeNodeAttemptValueSource,
        { slot: 'upstream_output' }
      >['source'];
      valueIdentity: NativeCallableValueIdentity;
    }>;

export type NativeCallableSourceProjection = Readonly<{
  runInput: Extract<
    NativeCallableValueDescriptor,
    { slot: 'run_input' }
  > | null;
  outputs: readonly Readonly<{
    invocationKey: string;
    output: Output;
    valueSource: Extract<
      NativeCallableValueDescriptor,
      { slot: 'upstream_output' }
    >;
  }>[];
}>;

export type NativeCoordinatorValueOwnerInspection =
  | Readonly<{ kind: 'active'; databaseNow: string; deadlineAt: string | null }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>;

/**
 * Actual read owner must verify canonical delivery, exact revision and controls.
 * Entire checkout/query/reply is bounded; pending reads and disposal are joined.
 * No lease/receipt mutation, object reads or accepted-result reconciliation.
 */
export type InspectCoordinatorValueReadOwner = (
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    signal: AbortSignal;
    readTimeoutMillis: number;
  }>,
) => Promise<NativeCoordinatorValueOwnerInspection>;

/** Framework-owned cancellation/lifetime only; neither bytes nor commit authority. */
export type NativeCoordinatorResultPreparationScope = <T>(
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    signal: AbortSignal;
    inspectOwner: InspectCoordinatorValueReadOwner;
  }>,
  prepare: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

/**
 * Derive immutable declaration and accepted sources independently, then compare
 * exact demand, revision and ordered scope. Null means actual absent run input.
 * Release the short tenant read transaction before any codec/evaluator work.
 * Known outages use typed stops; wrong delivery/scope/integrity remain errors.
 */
export type LoadCallableCompletionSources = (
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    demand: NativeCoordinatorMaterialDemand;
    signal: AbortSignal;
    readTimeoutMillis: number;
  }>,
) => Promise<
  | Readonly<{ kind: 'ready'; projection: NativeCallableSourceProjection }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>
>;

/** Independently recheck current consumer and exact accepted identity per fetch. */
export type ReadCallableCompletionSource = (
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    source: NativeCallableValueDescriptor;
    signal: AbortSignal;
    readTimeoutMillis: number;
  }>,
) => Promise<
  | Readonly<{ kind: 'ready'; valueSource: NativeNodeAttemptValueSource }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>
>;

/** Fresh current-owner read of one actual immutable Call declaration. */
export type ReadCoordinatorCallDeclaration = (
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    source: NativeCoordinatorCallDeclarationSource;
    signal: AbortSignal;
    readTimeoutMillis: number;
  }>,
) => Promise<
  | Readonly<{ kind: 'ready'; source: NativeCoordinatorCallDeclarationSource }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>
>;

/** Detached original-byte hydration only; this callback is not admission authority. */
export type NativeCoordinatorCallDeclarationHydrator = (
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    source: NativeCoordinatorCallDeclarationSource;
    signal: AbortSignal;
  }>,
) => Promise<unknown>;
