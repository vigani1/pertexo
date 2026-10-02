import type { WorkflowCallPinV1 } from '@pertexo/workflow-model/workflow-call-contract';
import type {
  BranchLedgerEntry,
  InvocationState,
  JoinState,
  OutputReference,
  WorkflowCheckpointV2,
} from './types.js';

/** A child result is not the immutable declaration attempt's output. */
export interface WorkflowCallResultReferenceV1 {
  readonly kind: 'workflow_call';
  readonly invocationKey: string;
  readonly childRunId: string;
}

export type WorkflowCallOutputReferenceV1 =
  OutputReference | WorkflowCallResultReferenceV1;

export const WORKFLOW_CALL_REFUSAL_CODES_V1 = [
  'workflow.child_capacity_unavailable',
  'workflow.child_queue_unavailable',
  'workflow.child_entitlement_unavailable',
  'workflow.child_authority_unavailable',
  'workflow.child_admission_unavailable',
  'workflow.child_compatibility_unavailable',
] as const;
export type WorkflowCallRefusalCodeV1 =
  (typeof WORKFLOW_CALL_REFUSAL_CODES_V1)[number];

interface WorkflowCallDeclarationStateV1 {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly declarationAttemptId: string;
  readonly pin: WorkflowCallPinV1;
  readonly input: OutputReference;
  /** SHA-256 of the admitted input's canonical JSON, not its storage reference. */
  readonly inputChecksum: string;
}

export type WorkflowCallStateV1 = WorkflowCallDeclarationStateV1 &
  (
    | Readonly<{ readonly status: 'awaiting_admission' }>
    | Readonly<{ readonly status: 'admitted'; readonly childRunId: string }>
    | Readonly<{
        readonly status: 'refused';
        readonly reasonCode: WorkflowCallRefusalCodeV1;
      }>
    | Readonly<{
        readonly status: 'aborted';
        readonly reasonCode: 'workflow.canceled' | 'workflow.timed_out';
      }>
    | Readonly<{
        readonly status: 'settled';
        readonly childRunId: string;
        readonly childStatus:
          'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
      }>
  );

export interface WorkflowCallInvocationStateV1 extends Omit<
  InvocationState,
  'output'
> {
  readonly output?: WorkflowCallOutputReferenceV1;
}

export interface WorkflowCallBranchLedgerEntryV1 extends Omit<
  BranchLedgerEntry,
  'output'
> {
  readonly output?: WorkflowCallOutputReferenceV1;
}

export interface WorkflowCallJoinStateV1 extends Omit<JoinState, 'ledger'> {
  readonly ledger: readonly WorkflowCallBranchLedgerEntryV1[];
}

/** Explicit wire version: retained checkpoint V1/V2 do not gain Call semantics. */
export interface WorkflowCheckpointV3 extends Omit<
  WorkflowCheckpointV2,
  'schemaVersion' | 'invocations' | 'joins'
> {
  readonly schemaVersion: 3;
  readonly invocations: readonly WorkflowCallInvocationStateV1[];
  readonly joins: readonly WorkflowCallJoinStateV1[];
  readonly calls: readonly WorkflowCallStateV1[];
}
