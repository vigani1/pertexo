import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  recordCallDeclarationInputSchema,
  readCallDeclarationInputSchema,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValueV1,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

type Request = Parameters<
  NonNullable<NodeAttemptRunStore['recordCallDeclarationInput']>
>[0];

export function workflowCallAttemptAuthorityJson(
  lease: Pick<
    NodeAttemptLease,
    | 'runId'
    | 'workflowVersionId'
    | 'nodeRunId'
    | 'attemptId'
    | 'attemptNumber'
    | 'invocationKey'
    | 'nodeId'
    | 'workerId'
    | 'fenceToken'
    | 'delivery'
  >,
): string {
  return serializeStoredExecutionJsonValue({
    runId: lease.runId,
    workflowVersionId: lease.workflowVersionId,
    nodeRunId: lease.nodeRunId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    invocationKey: lease.invocationKey,
    nodeId: lease.nodeId,
    workerId: lease.workerId,
    fenceToken: lease.fenceToken,
    delivery: lease.delivery,
  });
}
const snapshotSchema = z
  .object({
    reference: z.unknown(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().min(1).max(1_048_576),
    serializedValue: z.string().max(262_144).optional(),
  })
  .strict();

export async function readWorkflowCallDeclarationInput(
  pool: Pool,
  request: Parameters<
    NonNullable<NodeAttemptRunStore['readCallDeclarationInput']>
  >[0],
): ReturnType<NonNullable<NodeAttemptRunStore['readCallDeclarationInput']>> {
  const input = readCallDeclarationInputSchema.parse(request);
  assertNotAborted(input.signal);
  return withWorkspaceWriteClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        input.lease.workspaceId,
      ]);
      const result = await client.query<{ snapshot: unknown }>(
        'select app.read_workflow_call_declaration_input($1::jsonb) as snapshot',
        [workflowCallAttemptAuthorityJson(input.lease)],
      );
      assertNotAborted(input.signal);
      if (result.rows.length !== 1)
        throw new TypeError('Call snapshot result is missing');
      const row = result.rows[0];
      if (row === undefined)
        throw new TypeError('Call snapshot result is missing');
      const snapshot = row.snapshot;
      if (snapshot === null) return undefined;
      const parsed = snapshotSchema.parse(snapshot);
      const reference = parseStoredExecutionValueV1(parsed.reference);
      if (reference.kind === 'inline') {
        const original = parsed.serializedValue;
        if (original === undefined)
          throw new TypeError('Call inline snapshot bytes are missing');
        if (
          Buffer.byteLength(original, 'utf8') !== parsed.byteLength ||
          parsed.byteLength > 262_144 ||
          Buffer.byteLength(
            `{"kind":"inline","schemaVersion":1,"value":${original}}`,
            'utf8',
          ) > 262_144 ||
          createHash('sha256').update(original).digest('hex') !== parsed.sha256
        )
          throw new TypeError('Call snapshot metadata does not match');
        const value: unknown = JSON.parse(original);
        if (
          serializeWorkflowExecutionJsonValueV3(value) !==
          serializeStoredExecutionJsonValue(reference.value)
        )
          throw new TypeError('Call snapshot bytes and reference do not agree');
      } else if (parsed.serializedValue !== undefined) {
        throw new TypeError('Call artifact snapshot contains inline bytes');
      }
      return Object.freeze({
        reference,
        sha256: parsed.sha256,
        byteLength: parsed.byteLength,
        ...(parsed.serializedValue === undefined
          ? {}
          : { serializedValue: parsed.serializedValue }),
      });
    },
  );
}

/** Required execution input, not the optional diagnostic writer. */
export async function recordWorkflowCallDeclarationInput(
  pool: Pool,
  request: Request,
): Promise<void> {
  const input = recordCallDeclarationInputSchema.parse(request);
  assertNotAborted(input.signal);
  const reference = parseStoredExecutionValueV1(input.reference);
  const referenceJson = serializeStoredExecutionValueV1(reference);
  let canonicalValue: string | null = null;
  if (reference.kind === 'inline') {
    canonicalValue = serializeStoredExecutionJsonValue(reference.value);
    if (
      Buffer.byteLength(canonicalValue, 'utf8') !== input.byteLength ||
      createHash('sha256').update(canonicalValue).digest('hex') !== input.sha256
    )
      throw new TypeError('Call declaration input metadata does not match');
  }
  const { lease } = input;
  const authority = workflowCallAttemptAuthorityJson(lease);
  await withWorkspaceWriteClient(
    pool,
    lease.workspaceId,
    input.signal,
    async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        lease.workspaceId,
      ]);
      await client.query(
        `select app.record_workflow_call_declaration_input(
          $1::jsonb,$2::jsonb,$3::text,$4::integer,$5::text
        )`,
        [
          authority,
          referenceJson,
          input.sha256,
          input.byteLength,
          canonicalValue,
        ],
      );
      assertNotAborted(input.signal);
    },
  );
}
