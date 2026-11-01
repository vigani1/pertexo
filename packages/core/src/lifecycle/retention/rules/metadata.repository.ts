import {
  workflowPresenceLeases,
  workflowPublicationRequests,
  usageEvents,
  workflowTestSuites,
  transportSecurityAuditFacts,
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
  workflowManualStartRejections,
} from '@pertexo/database/schema';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { RUN_SUMMARY_RETENTION_SQL } from '../../../runs/data-policy.js';
import { deletionRule } from '../deletion-rule.js';

const presenceExpired = lte(
  workflowPresenceLeases.expiresAt,
  sql`clock_timestamp()`,
);
export const presence = deletionRule('workflow_presence_leases', {
  table: workflowPresenceLeases,
  keys: [
    workflowPresenceLeases.workspaceId,
    workflowPresenceLeases.workflowId,
    workflowPresenceLeases.userId,
    workflowPresenceLeases.tabId,
  ],
  condition: presenceExpired,
  orderBy: [workflowPresenceLeases.expiresAt],
  recheck: presenceExpired,
});
const reviewExpired = sql`coalesce(${workflowPublicationRequests.decidedAt},${workflowPublicationRequests.expiresAt})<=clock_timestamp()-interval '30 days'`;
export const publicationRequests = deletionRule('publication_requests', {
  table: workflowPublicationRequests,
  keys: [
    workflowPublicationRequests.workspaceId,
    workflowPublicationRequests.id,
  ],
  condition: reviewExpired,
  orderBy: [
    sql`coalesce(${workflowPublicationRequests.decidedAt},${workflowPublicationRequests.expiresAt})`,
    workflowPublicationRequests.id,
  ],
  recheck: reviewExpired,
});
const skipsExpired = and(
  inArray(usageEvents.category, ['trigger.skipped', 'trigger.coordinated']),
  sql`${usageEvents.occurredAt}<=clock_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
);
export const triggerSkips = deletionRule('trigger_skips', {
  table: usageEvents,
  keys: [usageEvents.id],
  condition: skipsExpired,
  orderBy: [usageEvents.occurredAt, usageEvents.id],
  recheck: skipsExpired,
});
/** One row per finished step test. It outlives its preview, which goes within a week. */
const previewUsageExpired = and(
  eq(usageEvents.category, 'preview_execution'),
  sql`${usageEvents.occurredAt}<=clock_timestamp()-${RUN_SUMMARY_RETENTION_SQL}`,
);
export const previewUsage = deletionRule('preview_usage', {
  table: usageEvents,
  keys: [usageEvents.id],
  condition: previewUsageExpired,
  orderBy: [usageEvents.occurredAt, usageEvents.id],
  recheck: previewUsageExpired,
});
const suiteExpired = lte(workflowTestSuites.expiresAt, sql`clock_timestamp()`);
export const testSuites = deletionRule('workflow_test_suites', {
  table: workflowTestSuites,
  keys: [workflowTestSuites.id],
  condition: suiteExpired,
  orderBy: [workflowTestSuites.expiresAt, workflowTestSuites.id],
  recheck: suiteExpired,
});
export const transportFacts = deletionRule('transport_security_audit_facts', {
  table: transportSecurityAuditFacts,
  keys: [transportSecurityAuditFacts.id],
  condition: sql`${transportSecurityAuditFacts.occurredAt}<=clock_timestamp()-interval '365 days'`,
  orderBy: [
    transportSecurityAuditFacts.occurredAt,
    transportSecurityAuditFacts.id,
  ],
});
// A command's stored result answers retries until its key expires.
export const commandReceipts = deletionRule('idempotency_records', {
  table: idempotencyRecords,
  keys: [idempotencyRecords.id],
  condition: and(
    eq(idempotencyRecords.status, 'completed'),
    lte(idempotencyRecords.expiresAt, sql`clock_timestamp()`),
  ),
  orderBy: [idempotencyRecords.expiresAt, idempotencyRecords.id],
});
export const creationReceipts = deletionRule('workspace_creation_records', {
  table: workspaceCreationIdempotencyRecords,
  keys: [workspaceCreationIdempotencyRecords.id],
  condition: and(
    inArray(workspaceCreationIdempotencyRecords.status, [
      'completed',
      'failed',
    ]),
    lte(workspaceCreationIdempotencyRecords.expiresAt, sql`clock_timestamp()`),
  ),
  orderBy: [
    workspaceCreationIdempotencyRecords.expiresAt,
    workspaceCreationIdempotencyRecords.id,
  ],
});
export const startRejections = deletionRule('manual_start_rejections', {
  table: workflowManualStartRejections,
  keys: [
    workflowManualStartRejections.workspaceId,
    workflowManualStartRejections.scope,
    workflowManualStartRejections.keyHash,
  ],
  condition: lte(
    workflowManualStartRejections.expiresAt,
    sql`clock_timestamp()`,
  ),
  orderBy: [workflowManualStartRejections.expiresAt],
});
