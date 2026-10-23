import {
  apiPool,
  finishTransactionClient,
  workspaceId,
} from '../../../support/workflow-authoring.js';

type LifecycleFacts = Readonly<{
  lifecycleStatus: string;
  lifecycleRevision: number;
  activationStatus: string;
  publishedVersionId: string | null;
  idempotencyClaims: number;
  reconciliationOutbox: number;
  auditEvents: number;
}>;

export async function lifecycleFacts(
  workflowId: string,
): Promise<LifecycleFacts> {
  const client = await apiPool.connect();
  let transactionOpen = false;
  let primaryError: unknown;
  let facts: LifecycleFacts | undefined;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<{
      lifecycle_status: string;
      lifecycle_revision: number;
      activation_status: string;
      published_version_id: string | null;
      idempotency_claims: string;
      reconciliation_outbox: string;
      audit_events: string;
    }>(
      `select lifecycle_status,lifecycle_revision,activation_status,
          published_version_id,
          (select count(*) from app.idempotency_records
            where resource_id=$1 and operation='workflow.archive')::text idempotency_claims,
          (select count(*) from app.outbox_events
            where aggregate_id=$1 and job_name='reconcile-workflow-triggers')::text reconciliation_outbox,
          (select count(*) from app.audit_events
            where target_id=$1 and action in ('workflow.archived','workflow.restored'))::text audit_events
       from app.workflows where id=$1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow facts missing');
    await client.query('commit');
    transactionOpen = false;
    facts = {
      lifecycleStatus: row.lifecycle_status,
      lifecycleRevision: row.lifecycle_revision,
      activationStatus: row.activation_status,
      publishedVersionId: row.published_version_id,
      idempotencyClaims: Number(row.idempotency_claims),
      reconciliationOutbox: Number(row.reconciliation_outbox),
      auditEvents: Number(row.audit_events),
    };
  } catch (error: unknown) {
    primaryError = error;
  }
  await finishTransactionClient(client, {
    label: 'Lifecycle facts query',
    primaryError,
    transactionOpen,
  });
  if (facts === undefined)
    throw new Error('Lifecycle facts query returned no facts');
  return facts;
}
