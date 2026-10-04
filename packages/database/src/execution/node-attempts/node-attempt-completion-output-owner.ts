import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  NodeAttemptStateCorruptError,
  type completionSchema,
} from './node-attempt-run-store-contract.js';
import { assertNotAborted } from './node-attempt-run-store-transactions.js';
import { workflowCallAttemptAuthorityJson } from './node-attempt-call-input-record.js';

/** Enter the actual protected output owner before ordinary descendant locks.
 * Durable physical replay stays with the existing completion reconciliation.
 */
export async function prepareNodeAttemptCompletionOutput(
  client: PoolClient,
  input: z.output<typeof completionSchema>,
  outputSource: 'legacy_inline' | 'workflow_call_input_alias',
  serializedOutput: string | null,
): Promise<string | null> {
  if (outputSource === 'workflow_call_input_alias') {
    if (input.outcome.status !== 'succeeded')
      throw new NodeAttemptStateCorruptError();
    assertNotAborted(input.signal);
    // Enter the protected owner before acquiring descendant locks. It
    // locks ancestors first, then receipt/current run/node/attempt, and
    // distinguishes live completion from durable physical replay. The
    // ordinary completion locks below are reentrant in this transaction.
    const alias = await client.query<{ reference: string | null }>(
      'select app.workflow_call_declaration_completion_reference($1::jsonb) as reference',
      [workflowCallAttemptAuthorityJson(input.lease)],
    );
    const reference = alias.rows[0]?.reference;
    if (
      alias.rows.length !== 1 ||
      typeof reference !== 'string' ||
      Buffer.byteLength(reference, 'utf8') > 4_194_304
    )
      throw new NodeAttemptStateCorruptError();
    // Preserve the first immutable projection, not its rounded driver
    // object. The protected owner proves source and replay identity.
    serializedOutput = reference;
    assertNotAborted(input.signal);
  } else if (serializedOutput !== null) {
    // Immutable format classification only, before descendant locks. The
    // native protected owner independently rechecks the ACTUAL lease and
    // canonical delivery, locking ancestors first. Retained completions
    // do not invoke an uninstalled native command.
    const format = await client.query<{
      native_execution: boolean;
      physical_completion_recorded: boolean;
    }>(
      `select (run.cancel_requested_at is not null or
         (run.deadline_at is not null and run.deadline_at<=clock_timestamp())) abort_requested,
       exists(select 1 from app.workflow_versions version
         where version.workspace_id=run.workspace_id
           and version.id=run.workflow_version_id
           and version.schema_version=2 and version.executable_schema_version=3) native_execution,
       exists(select 1 from app.node_attempts attempt
         join app.inbox_receipts receipt on receipt.workspace_id=attempt.workspace_id
           and receipt.consumer_name='node-attempt-worker' and receipt.message_id=$5
           and receipt.payload_checksum=$6 and receipt.completed_at is not null
         where attempt.workspace_id=run.workspace_id and attempt.id=$4
           and attempt.status='succeeded' and attempt.completed_at is not null) physical_completion_recorded
       from app.workflow_runs run where run.workspace_id=$1 and run.id=$2
         and run.workflow_version_id=$3`,
      [
        input.lease.workspaceId,
        input.lease.runId,
        input.lease.workflowVersionId,
        input.lease.attemptId,
        input.lease.delivery.outboxEventId,
        input.lease.delivery.payloadChecksum,
      ],
    );
    assertNotAborted(input.signal);
    if (format.rows.length !== 1) throw new NodeAttemptStateCorruptError();
    if (
      input.nativeOutput !== undefined &&
      format.rows[0]?.native_execution !== true
    )
      throw new NodeAttemptStateCorruptError();
    // Only actual durable physical success selects the existing duplicate
    // reconciliation below. It grants no new production/read authority.
    if (
      format.rows[0]?.native_execution === true &&
      !format.rows[0].physical_completion_recorded
    ) {
      await client.query(
        'select app.prelock_native_attempt_value_owner($1::jsonb)',
        [workflowCallAttemptAuthorityJson(input.lease)],
      );
      assertNotAborted(input.signal);
    }
  }
  return serializedOutput;
}
