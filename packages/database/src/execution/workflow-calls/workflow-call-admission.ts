import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';

import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import {
  parseStoredExecutionValueV1,
  serializeWorkflowExecutionJsonValueV3,
  type StoredExecutionValueV1,
} from '../stored-execution-value.js';
import {
  workflowRunStatusSchema,
  type AcceptedWorkflowRun,
} from '../runs/execution-acceptance-contract.js';

export const workflowCallAdmissionContextSchema = z
  .object({
    parentRunId: z.uuid(),
    expectedParentRevision: z.number().int().min(0).max(2_147_483_646),
    parentDelivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    invocationKey: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 256),
  })
  .strict();
const refusalCodeSchema = z.enum([
  'workflow.child_capacity_unavailable',
  'workflow.child_queue_unavailable',
  'workflow.child_entitlement_unavailable',
  'workflow.child_authority_unavailable',
  'workflow.child_admission_unavailable',
  'workflow.child_compatibility_unavailable',
]);
const common = {
  pin: workflowCallPinSchemaV1,
  engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
};
const timestampSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.date().transform((value) => value.toISOString()),
]);
const proofSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('allowed'),
      ...common,
      inputRef: z.unknown(),
      inputRefJson: z.string().max(4_194_304),
      inputChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      deadlineAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('recorded'),
      ...common,
      accepted: z
        .object({
          acceptedAt: timestampSchema.transform((value) => new Date(value)),
          outboxEventId: z.uuid(),
          runId: z.uuid(),
          status: workflowRunStatusSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('refused'),
      ...common,
      reasonCode: refusalCodeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('stopped'),
      ...common,
      reason: z.enum(['cancel_requested', 'deadline_expired']),
    })
    .strict(),
]);

/** Internal context: no caller-selected workspace, root, actor or child ID. */
export type WorkflowCallAdmissionContext = Readonly<
  z.input<typeof workflowCallAdmissionContextSchema>
>;
export type WorkflowCallAdmissionRefusalCode = z.output<
  typeof refusalCodeSchema
>;
export class WorkflowCallAdmissionRefusedError extends Error {
  public override readonly name = 'WorkflowCallAdmissionRefusedError';
  public constructor(
    public readonly reasonCode: WorkflowCallAdmissionRefusalCode,
  ) {
    super(reasonCode);
  }
}
export class WorkflowCallAdmissionStoppedError extends Error {
  public override readonly name = 'WorkflowCallAdmissionStoppedError';
  public constructor(
    public readonly reason: 'cancel_requested' | 'deadline_expired',
  ) {
    super('Workflow Call admission observed an ancestor stop');
  }
}
export class WorkflowCallAdmissionCorruptError extends Error {
  public override readonly name = 'WorkflowCallAdmissionCorruptError';
  public constructor() {
    super('Workflow Call admission proof is invalid');
  }
}

export type WorkflowCallAdmissionProof =
  | Readonly<{ kind: 'recorded'; accepted: AcceptedWorkflowRun }>
  | Readonly<{
      kind: 'allowed';
      context: WorkflowCallAdmissionContext;
      candidateRunId: string;
      inputRef: StoredExecutionValueV1;
      storedInputJson: string;
      inputChecksum: string;
      deadlineAt: string;
      pin: z.output<typeof workflowCallPinSchemaV1>;
    }>;

/**
 * Canonical acceptance owns candidate allocation and calls this narrow proof.
 * Its coordinator has already acquired the ordered prerequisite/lineage locks
 * outside the candidate savepoint. SQL derives and revalidates all authority.
 * Only explicit locked policy results become refusals: SQLSTATE is never mapped.
 */
export async function lockWorkflowCallAdmission(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    context: WorkflowCallAdmissionContext;
    candidateRunId: string;
    workflowId: string;
    workflowVersionId: string;
    engineVersion: string;
  }>,
): Promise<WorkflowCallAdmissionProof> {
  const context = Object.freeze(
    workflowCallAdmissionContextSchema.parse(input.context),
  );
  const candidateRunId = z.uuid().parse(input.candidateRunId);
  const result = await transaction.db.execute<{ proof: unknown }>(sql`
    select app.lock_workflow_call_admission(
      ${context.parentRunId}::uuid,${context.expectedParentRevision}::integer,
      ${context.invocationKey},${candidateRunId}::uuid,
      ${context.parentDelivery.outboxEventId}::uuid,${context.parentDelivery.payloadChecksum}::text
    ) as proof
  `);
  if (result.rows.length !== 1) throw new WorkflowCallAdmissionCorruptError();
  const parsed = proofSchema.safeParse(result.rows[0]?.proof);
  if (!parsed.success) throw new WorkflowCallAdmissionCorruptError();
  const proof = parsed.data;
  if (
    proof.pin.workflowId !== input.workflowId ||
    proof.pin.versionId !== input.workflowVersionId ||
    proof.engineVersion !== input.engineVersion
  )
    throw new WorkflowCallAdmissionCorruptError();
  if (proof.kind === 'refused')
    throw new WorkflowCallAdmissionRefusedError(proof.reasonCode);
  if (proof.kind === 'stopped')
    throw new WorkflowCallAdmissionStoppedError(proof.reason);
  if (proof.kind === 'recorded')
    return Object.freeze({
      kind: 'recorded',
      accepted: Object.freeze({ ...proof.accepted, duplicate: true }),
    });
  let inputRef: StoredExecutionValueV1;
  try {
    inputRef = parseStoredExecutionValueV1(proof.inputRef);
    const raw = parseStoredExecutionValueV1(
      JSON.parse(proof.inputRefJson) as unknown,
    );
    if (
      Buffer.byteLength(proof.inputRefJson, 'utf8') > 4_194_304 ||
      serializeWorkflowExecutionJsonValueV3(raw) !==
        serializeWorkflowExecutionJsonValueV3(inputRef)
    )
      throw new WorkflowCallAdmissionCorruptError();
  } catch {
    throw new WorkflowCallAdmissionCorruptError();
  }
  return Object.freeze({
    kind: 'allowed',
    context,
    candidateRunId,
    inputRef,
    storedInputJson: proof.inputRefJson,
    inputChecksum: proof.inputChecksum,
    deadlineAt: proof.deadlineAt,
    pin: Object.freeze(proof.pin),
  });
}

/** Reserve through the existing canonical FIFO owner, never a second counter. */
export async function reserveWorkflowCallAdmission(
  transaction: WorkspaceTransaction,
  proof: Extract<WorkflowCallAdmissionProof, { kind: 'allowed' }>,
  outboxEventId: string,
): Promise<void> {
  const outboxId = z.uuid().parse(outboxEventId);
  const result = await transaction.db.execute<{ reserved: unknown }>(sql`
    select app.reserve_workflow_call_active_admission(
      ${proof.context.parentRunId}::uuid,${proof.context.expectedParentRevision}::integer,
      ${proof.context.invocationKey},${proof.candidateRunId}::uuid,${outboxId}::uuid,
      ${proof.context.parentDelivery.outboxEventId}::uuid,${proof.context.parentDelivery.payloadChecksum}::text
    ) as reserved
  `);
  if (result.rows.length !== 1 || typeof result.rows[0]?.reserved !== 'boolean')
    throw new WorkflowCallAdmissionCorruptError();
  if (!result.rows[0].reserved)
    throw new WorkflowCallAdmissionRefusedError(
      'workflow.child_capacity_unavailable',
    );
}
