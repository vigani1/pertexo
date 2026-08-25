import { createHash, randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import {
  parseInitialPhase3Checkpoint,
  serializePersistedPhase3Checkpoint,
} from './phase3-checkpoint.js';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from './schema.js';
import { serializeStoredExecutionValueV1 } from './stored-execution-value.js';
import type { WorkspaceTransaction } from './workspace.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

const acceptWorkflowRunInputSchema = z
  .object({
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    initialCheckpoint: z.unknown(),
    deadlineAt: z.date().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

const resultRefSchema = z
  .object({
    outboxEventId: z.uuid(),
    initialCheckpointHash: sha256Schema.optional(),
  })
  .strict();

export const RUN_STATUS = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const RUN_STATUS_VALUES = Object.values(RUN_STATUS) as [
  RunStatus,
  ...RunStatus[],
];

export const IDEMPOTENCY_STATUS = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const;

export type IdempotencyStatus =
  (typeof IDEMPOTENCY_STATUS)[keyof typeof IDEMPOTENCY_STATUS];
export const IDEMPOTENCY_STATUS_VALUES = Object.values(IDEMPOTENCY_STATUS) as [
  IdempotencyStatus,
  ...IdempotencyStatus[],
];

const workflowRunStatusSchema = z.enum(RUN_STATUS_VALUES);

export type AcceptWorkflowRunInput = Readonly<
  z.input<typeof acceptWorkflowRunInputSchema>
>;

export type AcceptedWorkflowRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  outboxEventId: string;
  runId: string;
  status: z.output<typeof workflowRunStatusSchema>;
}>;

export class IdempotencyRequestConflictError extends Error {
  public override readonly name = 'IdempotencyRequestConflictError';

  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class IdempotencyRecordCorruptError extends Error {
  public override readonly name = 'IdempotencyRecordCorruptError';

  public constructor() {
    super('Persisted workflow run acceptance is incomplete or invalid');
  }
}

export class WorkspaceRunAdmissionDeniedError extends Error {
  public override readonly name = 'WorkspaceRunAdmissionDeniedError';

  public constructor() {
    super('workspace.run_admission_denied');
  }
}

async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const result = await transaction.db.execute<{ status: string }>(sql`
    select status
    from app.workspaces
    where id = ${transaction.workspaceId}
    for share
  `);

  if (result.rows[0]?.status !== 'active') {
    throw new WorkspaceRunAdmissionDeniedError();
  }
}

type ResolvedFailureNotificationPolicy = Readonly<{
  policyVersion: 1;
  destinationId: string;
  destinationConfigVersion: number;
  sideEffectClass: 'idempotent_with_key' | 'unsafe';
  connectionSecretVersionId: string;
}>;

/** Shared acceptance-time resolver for manual, webhook, and schedule admission. */
export async function resolveWorkflowFailureNotificationPolicy(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<ResolvedFailureNotificationPolicy | undefined> {
  const destinationResult = await transaction.db.execute<{
    connection_id: string | null;
    destination_id: string;
    current_config_version: number;
    destination_status: string;
    side_effect_class: 'idempotent_with_key' | 'unsafe';
    kind: 'email' | 'slack';
    workspace_status: string;
  }>(sql`
    select destination.id as destination_id,
           destination.current_config_version,
           destination.status as destination_status,
           workspace.status as workspace_status,
           version.kind,
           version.side_effect_class,
           case
             when jsonb_typeof(version.config) = 'object'
               and version.config ? 'connectionId'
               and (version.config->>'connectionId') ~
                 '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             then (version.config->>'connectionId')::uuid
             else null
           end as connection_id
    from app.workflow_failure_notification_policies policy
    join app.failure_notification_destinations destination
      on destination.workspace_id = policy.workspace_id
     and destination.id = policy.destination_id
    join app.failure_notification_destination_versions version
      on version.workspace_id = destination.workspace_id
     and version.destination_id = destination.id
     and version.version = destination.current_config_version
    join app.workspaces workspace on workspace.id = policy.workspace_id
    where policy.workspace_id = ${transaction.workspaceId}
      and policy.workflow_id = ${workflowId}
    for share of policy, destination, workspace
  `);
  const destination = destinationResult.rows[0];
  if (
    destination?.connection_id == null ||
    destination.workspace_status !== 'active' ||
    destination.destination_status !== 'enabled' ||
    (destination.kind === 'slack' &&
      destination.side_effect_class !== 'unsafe') ||
    (destination.kind === 'email' &&
      destination.side_effect_class !== 'idempotent_with_key')
  )
    return undefined;

  const connectionResult = await transaction.db.execute<{
    auth_type: string;
    current_secret_version_id: string;
    provider_key: string;
    status: string;
  }>(sql`
    select connection.auth_type,
           connection.current_secret_version_id,
           connection.provider_key,
           connection.status
    from app.connections connection
    where connection.workspace_id = ${transaction.workspaceId}
      and connection.id = ${destination.connection_id}
    for share of connection
  `);
  const connection = connectionResult.rows[0];
  if (
    connection?.status !== 'active' ||
    (destination.kind === 'slack' &&
      (connection.provider_key !== 'slack' ||
        connection.auth_type !== 'slack_bot_token')) ||
    (destination.kind === 'email' &&
      (connection.provider_key !== 'email' ||
        connection.auth_type !== 'resend_api_key'))
  )
    return undefined;

  const secretResult = await transaction.db.execute<{ id: string }>(sql`
    select secret.id
    from app.connection_secret_versions secret
    where secret.workspace_id = ${transaction.workspaceId}
      and secret.connection_id = ${destination.connection_id}
      and secret.id = ${connection.current_secret_version_id}
  `);
  if (secretResult.rows[0] === undefined) return undefined;

  return Object.freeze({
    policyVersion: 1,
    destinationId: z.uuid().parse(destination.destination_id),
    destinationConfigVersion: z
      .number()
      .int()
      .positive()
      .parse(destination.current_config_version),
    sideEffectClass: z
      .enum(['idempotent_with_key', 'unsafe'])
      .parse(destination.side_effect_class),
    connectionSecretVersionId: z
      .uuid()
      .parse(connection.current_secret_version_id),
  });
}

async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    z.output<typeof acceptWorkflowRunInputSchema>,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
  initialCheckpointHash: string | undefined,
  verifyInitialCheckpointHash = true,
): Promise<AcceptedWorkflowRun | null> {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: workflowRuns.createdAt,
      runStatus: workflowRuns.status,
    })
    .from(idempotencyRecords)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(workflowRuns.id, idempotencyRecords.resourceId),
      ),
    )
    .where(
      and(
        eq(idempotencyRecords.workspaceId, transaction.workspaceId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.scope, input.scope),
        eq(idempotencyRecords.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return null;
  }
  if (row.requestHash !== input.requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  const resultRef = resultRefSchema.safeParse(row.resultRef);
  const runStatus = workflowRunStatusSchema.safeParse(row.runStatus);
  if (
    row.idempotencyStatus !== IDEMPOTENCY_STATUS.completed ||
    row.acceptedAt === null ||
    !resultRef.success ||
    !runStatus.success
  ) {
    throw new IdempotencyRecordCorruptError();
  }
  if (
    verifyInitialCheckpointHash &&
    resultRef.data.initialCheckpointHash !== initialCheckpointHash
  ) {
    throw new IdempotencyRequestConflictError();
  }

  return Object.freeze({
    acceptedAt: row.acceptedAt,
    duplicate: true,
    outboxEventId: resultRef.data.outboxEventId,
    runId: row.resourceId,
    status: runStatus.data,
  });
}

const acceptanceReplayInputSchema = acceptWorkflowRunInputSchema.pick({
  keyHash: true,
  operation: true,
  requestHash: true,
  scope: true,
});

export type WorkflowRunAcceptanceReplayInput = Readonly<
  z.input<typeof acceptanceReplayInputSchema>
>;

/** Resolve a completed exact request replay before reading current workflow state. */
export async function readWorkflowRunAcceptanceReplay(
  transaction: WorkspaceTransaction,
  input: WorkflowRunAcceptanceReplayInput,
): Promise<AcceptedWorkflowRun | null> {
  const parsed = acceptanceReplayInputSchema.parse(input);
  return readExistingAcceptance(transaction, parsed, undefined, false);
}

export async function acceptWorkflowRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput,
): Promise<AcceptedWorkflowRun> {
  const parsed = acceptWorkflowRunInputSchema.parse(input);
  const storedRunInputJson =
    parsed.runInput === undefined
      ? null
      : serializeStoredExecutionValueV1({
          schemaVersion: 1,
          kind: 'inline',
          value: parsed.runInput,
        });
  const initialCheckpointJson = serializePersistedPhase3Checkpoint(
    parseInitialPhase3Checkpoint(parsed.initialCheckpoint, {
      engineVersion: parsed.engineVersion,
      workflowVersionId: parsed.workflowVersionId,
    }),
  );
  const initialCheckpointHash = createHash('sha256')
    .update(initialCheckpointJson)
    .digest('hex');
  const existing = await readExistingAcceptance(
    transaction,
    parsed,
    initialCheckpointHash,
  );
  if (existing !== null) return existing;

  await assertWorkspaceAcceptsNewRuns(transaction);
  const failureNotificationPolicy =
    await resolveWorkflowFailureNotificationPolicy(
      transaction,
      parsed.workflowId,
    );
  const idempotencyRecordId = randomUUID();
  const runId = randomUUID();
  const outboxEventId = randomUUID();
  const resultRef = {
    outboxEventId,
    initialCheckpointHash,
  } as const;

  const insertedClaim = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id: idempotencyRecordId,
      workspaceId: transaction.workspaceId,
      operation: parsed.operation,
      scope: parsed.scope,
      keyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
      status: IDEMPOTENCY_STATUS.inProgress,
      resourceId: runId,
      resultRef: {},
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.workspaceId,
        idempotencyRecords.operation,
        idempotencyRecords.scope,
        idempotencyRecords.keyHash,
      ],
    })
    .returning({ id: idempotencyRecords.id });

  if (insertedClaim.length === 0) {
    const racedAcceptance = await readExistingAcceptance(
      transaction,
      parsed,
      initialCheckpointHash,
    );
    if (racedAcceptance === null) throw new IdempotencyRecordCorruptError();
    return racedAcceptance;
  }

  const insertedRuns = await transaction.db
    .insert(workflowRuns)
    .values({
      id: runId,
      workspaceId: transaction.workspaceId,
      workflowId: parsed.workflowId,
      workflowVersionId: parsed.workflowVersionId,
      inputRef:
        storedRunInputJson === null ? null : sql`${storedRunInputJson}::jsonb`,
      triggerType: parsed.triggerType,
      ...(failureNotificationPolicy === undefined
        ? {}
        : {
            failureNotificationPolicyVersion:
              failureNotificationPolicy.policyVersion,
            failureNotificationDestinationId:
              failureNotificationPolicy.destinationId,
            failureNotificationDestinationConfigVersion:
              failureNotificationPolicy.destinationConfigVersion,
            failureNotificationSideEffectClass:
              failureNotificationPolicy.sideEffectClass,
            failureNotificationConnectionSecretVersionId:
              failureNotificationPolicy.connectionSecretVersionId,
          }),
      ...(parsed.deadlineAt === undefined
        ? {}
        : { deadlineAt: parsed.deadlineAt }),
      status: RUN_STATUS.queued,
    })
    .returning({ acceptedAt: workflowRuns.createdAt });
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) {
    throw new IdempotencyRecordCorruptError();
  }
  await transaction.db.insert(runEvents).values({
    workspaceId: transaction.workspaceId,
    workflowRunId: runId,
    sequence: 1,
    type: 'run.queued',
    payload: { schemaVersion: 1 },
  });
  await transaction.db.insert(runCheckpoints).values({
    workflowRunId: runId,
    workspaceId: transaction.workspaceId,
    workflowVersionId: parsed.workflowVersionId,
    revision: 0,
    engineVersion: parsed.engineVersion,
    schedulerState: sql`${initialCheckpointJson}::jsonb`,
  });

  const payload = {
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
    outboxEventId,
    runId,
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  } as const;
  await insertOutboxEvent(transaction, {
    id: outboxEventId,
    jobName: 'advance-workflow-run',
    schemaVersion: 1,
    aggregateType: 'workflow-run',
    aggregateId: runId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });

  const completedClaims = await transaction.db
    .update(idempotencyRecords)
    .set({
      resultRef,
      status: IDEMPOTENCY_STATUS.completed,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(idempotencyRecords.id, idempotencyRecordId),
        eq(idempotencyRecords.status, IDEMPOTENCY_STATUS.inProgress),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completedClaims.length !== 1) {
    throw new IdempotencyRecordCorruptError();
  }

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    duplicate: false,
    outboxEventId,
    runId,
    status: RUN_STATUS.queued,
  });
}
