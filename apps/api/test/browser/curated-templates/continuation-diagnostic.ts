import { z } from 'zod';

const boundedCount = z.number().int().min(0).max(100000);
export const curatedContinuationDiagnosticSchema = z.strictObject({
  checkpointRevision: boundedCount.nullable(),
  coordinatorOutbox: boundedCount,
  publishedOutbox: boundedCount,
  failedOutbox: boundedCount,
  completedReceipts: boundedCount,
  incompleteReceipts: boundedCount,
});

// SQL performs the projection; no payload, checkpoint JSON, inputs or outputs
// cross this diagnostic boundary. Identities are parameters and never logged.
export const curatedContinuationDiagnosticSql = `
  select
    (select revision::int from app.run_checkpoints
      where workspace_id=$1 and workflow_run_id=$2) as "checkpointRevision",
    count(*)::int as "coordinatorOutbox",
    count(*) filter (where published_at is not null)::int as "publishedOutbox",
    count(*) filter (where failed_at is not null)::int as "failedOutbox",
    (select count(*)::int from app.inbox_receipts receipt
      join app.outbox_events event on event.id=receipt.message_id
      where receipt.workspace_id=$1 and event.workspace_id=$1
        and event.aggregate_id=$2 and event.job_name='advance-workflow-run'
        and receipt.completed_at is not null) as "completedReceipts",
    (select count(*)::int from app.inbox_receipts receipt
      join app.outbox_events event on event.id=receipt.message_id
      where receipt.workspace_id=$1 and event.workspace_id=$1
        and event.aggregate_id=$2 and event.job_name='advance-workflow-run'
        and receipt.completed_at is null) as "incompleteReceipts"
  from app.outbox_events
  where workspace_id=$1 and aggregate_id=$2
    and job_name='advance-workflow-run'`;
