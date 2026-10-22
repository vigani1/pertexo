import { codeDiagnosticsSchema } from '@pertexo/node-sdk';
import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import type { WorkflowNodeFailureValue } from '@pertexo/workflow-model';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import { z } from 'zod';
import { SAFE_EXECUTOR_ERROR_CODE_PATTERN } from '@pertexo/workflow-model';
import { sha256HexSchema } from '../platform/persisted-primitives.js';

const identitySchema = z.string().regex(UUID_PATTERN);
const checksumSchema = sha256HexSchema;
const workerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const deliverySchema = z
  .object({
    outboxEventId: identitySchema,
    payloadChecksum: checksumSchema,
  })
  .strict();
export const claimDeliverySchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    delivery: deliverySchema,
    leaseDurationSeconds: z.number().int().min(1).max(300),
    workerId: workerIdSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
export const attemptJobPayloadSchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    outboxEventId: identitySchema,
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();

const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const invocationKeySchema = z.string().min(1).max(256);
export const NODE_ATTEMPT_INPUT_LIMITS = Object.freeze({
  upstreamNodeOutputs: 100,
});
const sideEffectClassSchema = z.enum(['safe', 'idempotent_with_key', 'unsafe']);
const admissionKindSchema = z.enum(['execute', 'retry', 'wait_resume']);
const branchScopePartSchema = z
  .object({
    nodeId: nodeIdSchema,
    outputPort: nodeIdSchema,
  })
  .strict();
const iterationScopePartSchema = z
  .object({
    loopNodeId: nodeIdSchema,
    ordinal: z.number().int().nonnegative(),
  })
  .strict();
export const branchContextSchema = z
  .object({
    branchPath: z.array(branchScopePartSchema).max(1_000).optional(),
    iterationPath: z.array(iterationScopePartSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine(({ branchPath }, context) => {
    if (
      branchPath !== undefined &&
      new Set(branchPath.map(({ nodeId }) => nodeId)).size !== branchPath.length
    )
      context.addIssue({
        code: 'custom',
        message: 'branch path contains a repeated node',
      });
  });

export type NodeAttemptDelivery = Readonly<z.output<typeof deliverySchema>>;

const providerDispatchBindingSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$/u);
export const connectionDispatchFenceSchema = z
  .object({
    connectionId: z.uuid(),
    expectedProviderKey: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
    expectedAuthType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
    secretVersionId: z.uuid(),
  })
  .strict();

export type NodeAttemptLease = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  admissionKind: 'execute' | 'retry' | 'wait_resume';
  invocationKey: string;
  nodeId: string;
  branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
  iterationPath?: readonly Readonly<{
    loopNodeId: string;
    ordinal: number;
  }>[];
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  providerIdempotencyKey?: string;
  providerDispatchBinding?: string;
  providerDispatchUnresolved?: true;
  workerId: string;
  fenceToken: number;
  leaseExpiresAt: Date;
  delivery: NodeAttemptDelivery;
}>;

const nodeAttemptLeaseSchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    workflowVersionId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    attemptNumber: z.number().int().positive(),
    admissionKind: admissionKindSchema,
    invocationKey: invocationKeySchema,
    nodeId: nodeIdSchema,
    branchPath: z.array(branchScopePartSchema).min(1).max(1_000).optional(),
    iterationPath: z
      .array(iterationScopePartSchema)
      .min(1)
      .max(1_000)
      .optional(),
    sideEffectClass: sideEffectClassSchema,
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    providerDispatchBinding: providerDispatchBindingSchema.optional(),
    providerDispatchUnresolved: z.literal(true).optional(),
    workerId: workerIdSchema,
    fenceToken: z.number().int().positive(),
    leaseExpiresAt: z.date(),
    delivery: deliverySchema,
  })
  .strict();

export const loadInputsSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    sourceFailure: z
      .object({ nodeId: nodeIdSchema, invocationKey: invocationKeySchema })
      .strict()
      .optional(),
    upstreamNodeOutputs: z
      .array(
        z
          .object({
            nodeId: nodeIdSchema,
            invocationKey: invocationKeySchema,
          })
          .strict(),
      )
      .max(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs)
      .refine(
        (values) =>
          new Set(values.map(({ invocationKey }) => invocationKey)).size ===
          values.length,
      ),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const ownedLeaseSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
export const dispatchSchema = ownedLeaseSchema
  .extend({
    connectionFence: connectionDispatchFenceSchema.optional(),
    providerDispatchBinding: providerDispatchBindingSchema.optional(),
  })
  .strict();
export const recordInputSchema = ownedLeaseSchema
  .extend({ input: z.unknown() })
  .strict();
export const heartbeatSchema = ownedLeaseSchema
  .extend({ leaseDurationSeconds: z.number().int().min(1).max(300) })
  .strict();
// These writers produce bounded private diagnostics, including unhandled
// storage and resource refusals. Provider messages remain excluded.
const dataExecutorSummaryCodes = new Set([
  'utility.invalid_data',
  'utility.text_fields',
  'utility.result_text',
  'utility.result_too_large',
  'utility.too_many_items',
  'utility.xml_name',
  'utility.xml_data',
  'utility.xml_input',
  'utility.xml_root',
  'utility.xml_malformed',
  'utility.xml_dtd',
  'utility.xml_depth',
  'utility.xml_size',
  'utility.html_selector',
  'utility.html_depth',
  'utility.html_size',
  'utility.crypto_input',
  'utility.hmac_connection',
  'utility.hmac_unavailable',
  'file.create_data',
  'file.create_columns',
  'file.create_size',
  'file.create_storage',
]);
const safeErrorCodeSchema = z.string().regex(SAFE_EXECUTOR_ERROR_CODE_PATTERN);
export const executorFailureKindSchema = z.enum([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
]);
export const executorErrorKindSchema = z.enum([
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
]);
const completionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), output: z.unknown() }).strict(),
  z
    .object({
      status: z.literal('suspended'),
      output: z.unknown(),
      durationSeconds: z.number().int().min(1).max(2_592_000),
    })
    .strict(),
  z
    .object({
      status: z.enum(['failed', 'canceled', 'timed_out', 'outcome_unknown']),
      safeErrorCode: safeErrorCodeSchema,
      errorSummary: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('executor_failure'),
      minimumRetryDelayMillis: z.number().int().min(0).max(60_000).optional(),
      failureKind: executorFailureKindSchema,
      errorKind: executorErrorKindSchema,
      possiblyDispatched: z.boolean(),
      safeErrorCode: safeErrorCodeSchema,
      errorSummary: z.string().max(2048).optional(),
    })
    .strict()
    .refine(
      (outcome) =>
        outcome.errorSummary === undefined ||
        dataExecutorSummaryCodes.has(outcome.safeErrorCode) ||
        outcome.safeErrorCode === 'execution.file_input' ||
        outcome.safeErrorCode.startsWith('http.pagination_') ||
        outcome.safeErrorCode === 'execution.attempt_invalid',
      'Only a sanitized data, file, pagination or step-refusal diagnostic can accompany an executor failure',
    ),
]);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();
export const connectionHealthObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('healthy') }).strict(),
  z
    .object({
      kind: z.literal('reauthorization_required'),
      reasonCode: z.enum([
        'connection.slack_account_inactive',
        'connection.slack_token_expired',
        'connection.slack_token_revoked',
      ]),
    })
    .strict(),
]);
export const completionSchema = ownedLeaseSchema
  .extend({
    outcome: completionOutcomeSchema,
    codeDiagnostics: codeDiagnosticsSchema.optional(),
    traceparent: traceparentSchema,
    connectionHealthObservation: connectionHealthObservationSchema.optional(),
  })
  .strict();

export type NodeAttemptClaimResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'claimed'; lease: NodeAttemptLease }>;

/** What the database holds for an attempt; execution projects the rest. */
export type NodeAttemptStoredInputs = Readonly<{
  runInput: unknown;
  variables?: WorkspaceVariableValues;
  completedNodeOutputs: readonly Readonly<{
    invocationKey: string;
    nodeId: string;
    value: unknown;
  }>[];
  sourceFailure?: WorkflowNodeFailureValue;
  resumeOutput?: unknown;
  abortRequested: boolean;
  abortReason?: 'canceled' | 'timed_out';
  deadlineAt?: Date;
  /** The run's stored checkpoint JSON. */
  checkpoint: unknown;
}>;

/** The succeeded output of the node that declared a For Each collection. */
export type NodeAttemptLoopDeclaration = Readonly<{
  nodeId: string;
  attemptId: string;
  output: unknown;
}>;

/** A succeeded attempt's stored output, such as a Merge branch's result. */
export type NodeAttemptStoredOutput = Readonly<{
  attemptId: string;
  output: unknown;
}>;

/** One settled run of a step, with the size of what it stored. */
export type NodeRunOutcome = Readonly<{
  invocationKey: string;
  status: 'succeeded' | 'skipped';
  outputBytes: number;
}>;

/** A succeeded step run's stored output, such as a For Each pass's result. */
export type NodeRunStoredOutput = Readonly<{
  invocationKey: string;
  output: unknown;
}>;

export type NodeAttemptCompletion =
  | Readonly<{ status: 'succeeded'; output: unknown }>
  | Readonly<{ status: 'suspended'; output: unknown; durationSeconds: number }>
  | Readonly<{
      status: 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
      safeErrorCode: string;
      errorSummary?: string;
    }>
  | Readonly<{
      status: 'executor_failure';
      failureKind: z.output<typeof executorFailureKindSchema>;
      minimumRetryDelayMillis?: number;
      errorKind: z.output<typeof executorErrorKindSchema>;
      possiblyDispatched: boolean;
      safeErrorCode: string;
      errorSummary?: string;
    }>;

export type CompleteNodeAttemptResult =
  | Readonly<{ kind: 'committed'; outboxEventId: string }>
  | Readonly<{ kind: 'duplicate'; outboxEventId: null }>;

export interface NodeAttemptRunStore {
  claimDelivery(
    input: Readonly<z.input<typeof claimDeliverySchema>>,
  ): Promise<NodeAttemptClaimResult>;
  loadInputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      upstreamNodeOutputs: readonly Readonly<{
        nodeId: string;
        invocationKey: string;
      }>[];
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptStoredInputs>;
  readLoopDeclaration(
    input: Readonly<{
      lease: NodeAttemptLease;
      controlInvocationKey: string;
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptLoopDeclaration | undefined>;
  readAttemptOutputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      attemptIds: readonly string[];
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeAttemptStoredOutput[]>;
  /** Every settled run of one step in the leased run, without outputs. */
  listNodeOutcomes(
    input: Readonly<{
      lease: NodeAttemptLease;
      nodeId: string;
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeRunOutcome[]>;
  readNodeOutputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      invocationKeys: readonly string[];
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeRunStoredOutput[]>;
  markDispatched(
    input: Readonly<{
      lease: NodeAttemptLease;
      connectionFence?: z.output<typeof connectionDispatchFenceSchema>;
      providerDispatchBinding?: string;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ dispatchedAt: Date }>>;
  heartbeat(
    input: Readonly<{
      lease: NodeAttemptLease;
      leaseDurationSeconds: number;
      signal: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      leaseExpiresAt: Date;
      abortRequested: boolean;
      abortReason?: 'canceled' | 'timed_out';
    }>
  >;
  /**
   * Records the input the attempt's executor is about to receive (ADR 052).
   * Diagnostic: it records nothing, and never throws, when the lease is gone
   * or the input is over the inline bound. A store may leave it out.
   */
  recordInput?(
    input: Readonly<{
      lease: NodeAttemptLease;
      input: unknown;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ recorded: boolean }>>;
  complete(
    input: Readonly<{
      lease: NodeAttemptLease;
      outcome: NodeAttemptCompletion;
      codeDiagnostics?: z.output<typeof codeDiagnosticsSchema>;
      connectionHealthObservation?: z.output<
        typeof connectionHealthObservationSchema
      >;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ): Promise<CompleteNodeAttemptResult>;
  close(): Promise<void>;
}

export class NodeAttemptDeliveryMismatchError extends Error {
  public override readonly name = 'NodeAttemptDeliveryMismatchError';
  public constructor() {
    super('Node attempt delivery does not match its durable outbox identity');
  }
}

export class NodeAttemptReconciliationRequiredError extends Error {
  public override readonly name = 'NodeAttemptReconciliationRequiredError';
  public constructor() {
    super('Node attempt requires lease reconciliation before execution');
  }
}

export class NodeAttemptDispatchBindingMismatchError extends Error {
  public override readonly name = 'NodeAttemptDispatchBindingMismatchError';
  public constructor() {
    super('Node attempt provider dispatch binding does not match');
  }
}

export class NodeAttemptConnectionFenceError extends Error {
  public override readonly name = 'NodeAttemptConnectionFenceError';
  public constructor() {
    super('Node attempt connection fence does not match current active state');
  }
}

export class NodeAttemptStateCorruptError extends Error {
  public override readonly name = 'NodeAttemptStateCorruptError';
  public constructor() {
    super('Persisted node attempt state is invalid');
  }
}

export class NodeAttemptOutputInvalidError extends Error {
  public override readonly name = 'NodeAttemptOutputInvalidError';
  public constructor() {
    super('Node attempt output violates the inline execution-value contract');
  }
}

export class DeliveryMismatch extends Error {}
