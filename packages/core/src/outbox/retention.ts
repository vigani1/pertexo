import {
  inboxReceipts,
  outboxEvents,
  workflowRunActiveAdmissions,
  workflowRuns,
} from '@pertexo/database/schema';
import { and, isNotNull, isNull, not, sql, type SQL } from 'drizzle-orm';

import { deletionRule } from '../lifecycle/retention/deletion-rule.js';

/** Past any redelivery, which gives up after about a day. */
const PUBLISHED_ROW_DAYS = 30;
/** What's on the operator's stuck-work list. It stays long enough to be seen. */
const FAILED_ROW_DAYS = 90;

/**
 * Whether anything still leans on a settled row. An admission's row holds the
 * run's slot, and deleting the row would cascade to the admission and free it. A
 * run that hasn't finished can still have its rows compared by capacity's functions.
 */
const stillNeeded: SQL = sql`(
  exists(
    select 1 from ${workflowRunActiveAdmissions} admission
     where admission.outbox_event_id = ${outboxEvents.id}
  )
  or (
    ${outboxEvents.aggregateType} = 'workflow-run'
    and exists(
      select 1 from ${workflowRuns} run
       where run.workspace_id = ${outboxEvents.workspaceId}
         and run.id = ${outboxEvents.aggregateId}
         and run.status in ('queued', 'running', 'waiting')
    )
  )
)`;

const publishedExpired = and(
  isNotNull(outboxEvents.publishedAt),
  isNull(outboxEvents.failedAt),
  // Still being watched for a receipt, so it's still somebody's promise.
  isNull(outboxEvents.deliveryDueAt),
  sql`${outboxEvents.publishedAt}<=clock_timestamp()-make_interval(days=>${PUBLISHED_ROW_DAYS})`,
  not(stillNeeded),
);
export const publishedOutboxEvents = deletionRule('outbox_published', {
  table: outboxEvents,
  keys: [outboxEvents.id],
  condition: publishedExpired,
  orderBy: [outboxEvents.publishedAt, outboxEvents.id],
  // An operator's redispatch can put the row back while the delete waits for it.
  recheck: publishedExpired,
});

const failedExpired = and(
  isNotNull(outboxEvents.failedAt),
  isNull(outboxEvents.deliveryDueAt),
  sql`${outboxEvents.failedAt}<=clock_timestamp()-make_interval(days=>${FAILED_ROW_DAYS})`,
  not(stillNeeded),
);
export const failedOutboxEvents = deletionRule('outbox_failed', {
  table: outboxEvents,
  keys: [outboxEvents.id],
  condition: failedExpired,
  orderBy: [outboxEvents.failedAt, outboxEvents.id],
  recheck: failedExpired,
});

/**
 * Only once its event has gone. A published event with no receipt reads as a lost
 * job, so a receipt leaving first would send old work round again.
 */
const receiptExpired = and(
  sql`${inboxReceipts.receivedAt}<=clock_timestamp()-make_interval(days=>${PUBLISHED_ROW_DAYS})`,
  sql`not exists(select 1 from ${outboxEvents} event where event.id = ${inboxReceipts.messageId})`,
);
export const inboxReceiptsPastEvents = deletionRule('inbox_receipts', {
  table: inboxReceipts,
  keys: [inboxReceipts.consumerName, inboxReceipts.messageId],
  condition: receiptExpired,
  orderBy: [inboxReceipts.receivedAt, inboxReceipts.messageId],
});
