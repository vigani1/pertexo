import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

const identitySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
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
    schemaVersion: z.literal(1),
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
  .regex(/^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$/u);
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
    upstreamNodeOutputs: z
      .array(
        z
          .object({
            nodeId: nodeIdSchema,
            invocationKey: invocationKeySchema,
          })
          .strict(),
      )
      .max(100)
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
export const heartbeatSchema = ownedLeaseSchema
  .extend({ leaseDurationSeconds: z.number().int().min(1).max(300) })
  .strict();
const safeErrorCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const executorFailureKindSchema = z.enum([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
]);
const executorErrorKindSchema = z.enum([
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
      failureKind: executorFailureKindSchema,
      errorKind: executorErrorKindSchema,
      possiblyDispatched: z.boolean(),
      safeErrorCode: safeErrorCodeSchema,
    })
    .strict(),
]);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();
export const completionSchema = ownedLeaseSchema
  .extend({ outcome: completionOutcomeSchema, traceparent: traceparentSchema })
  .strict();

export type NodeAttemptClaimResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'claimed'; lease: NodeAttemptLease }>;

export type NodeAttemptInputs = Readonly<{
  runInput: unknown;
  completedNodeOutputs: unknown;
  structuredCollection?: Readonly<{
    loopNodeId: string;
    ordinal: number;
    collection: unknown;
    collectionSize: number;
    declaredCollectionChecksum: string;
  }>;
  coordinatorInput?: unknown;
  resumeOutput?: unknown;
  abortRequested: boolean;
  abortReason?: 'canceled' | 'timed_out';
  deadlineAt?: Date;
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
      errorKind: z.output<typeof executorErrorKindSchema>;
      possiblyDispatched: boolean;
      safeErrorCode: string;
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
  ): Promise<NodeAttemptInputs>;
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
  complete(
    input: Readonly<{
      lease: NodeAttemptLease;
      outcome: NodeAttemptCompletion;
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

export class NodeAttemptControlActiveError extends Error {
  public override readonly name = 'NodeAttemptControlActiveError';
  public constructor() {
    super('Node attempt cannot start after durable run control activation');
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
