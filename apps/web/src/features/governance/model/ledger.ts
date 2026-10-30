import type { AuditEvent } from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';

type Phrase = Readonly<{ words: string; tone?: StatusTone }>;

/**
 * What each recorded action did, as the words after the person's name. The
 * audit log keeps only safe facts (no names), so the thing changed is named by
 * its kind and opened from the entry.
 */
const PHRASES: Readonly<Record<string, Phrase>> = {
  'workflow.created': { words: 'created a workflow' },
  'workflow.imported': { words: 'imported a workflow' },
  'workflow.duplicated': { words: 'duplicated a workflow' },
  'workflow.renamed': { words: 'renamed a workflow' },
  'workflow.draft_saved': { words: 'saved a draft' },
  'workflow.published': { words: 'published a workflow', tone: 'success' },
  'workflow.archived': { words: 'archived a workflow', tone: 'canceled' },
  'workflow.restored': { words: 'restored an archived workflow' },
  'workflow.version_restored': { words: 'copied a version into the draft' },
  'workflow.sample.saved': { words: 'pinned sample data to a step' },
  'workflow.sample.removed': { words: 'removed pinned sample data' },
  'workflow.error_policy_updated': {
    words: 'changed what runs when a workflow fails',
  },
  'workflow.concurrency_settings_changed': {
    words: 'changed how many runs can go at once',
  },
  'workflow.auto_pause_settings_changed': {
    words: 'changed when a workflow pauses itself',
  },
  'workflow.triggers_resumed': { words: 'resumed a paused workflow' },
  'workflow.publication_requested': { words: 'asked for a publishing review' },
  'workflow.publication_approved': {
    words: 'approved a publishing review',
    tone: 'success',
  },
  'workflow.publication_rejected': {
    words: 'declined a publishing review',
    tone: 'canceled',
  },
  'workflow.promoted': { words: 'promoted a workflow into this workspace' },
  'workflow.promotion_sent': {
    words: 'promoted a workflow to another workspace',
  },
  'workflow.run.started': { words: 'started a run' },
  'workflow.run.replayed': { words: 'ran a run again' },
  'workflow.run.cancel_requested': { words: 'asked a run to stop' },
  'workflow.run.recovered': { words: 'recovered a run' },
  'workflow.input_case.create': { words: 'saved a test input' },
  'workflow.input_case.update': { words: 'changed a saved test input' },
  'workflow.input_case.delete': {
    words: 'deleted a saved test input',
    tone: 'canceled',
  },
  'preview.execution_accepted': { words: 'tested a step' },
  'preview.execution_terminal': { words: 'finished testing a step' },
  'workflow.folder.create': { words: 'created a folder' },
  'workflow.folder.rename': { words: 'renamed a folder' },
  'workflow.folder.move': { words: 'moved a folder' },
  'workflow.folder.place': { words: 'put a workflow in a folder' },
  'workflow.folder.delete': { words: 'deleted a folder', tone: 'canceled' },
  'workflow.tag.create': { words: 'created a tag' },
  'workflow.tag.rename': { words: 'renamed a tag' },
  'workflow.tag.detach': { words: 'took a tag off a workflow' },
  'workflow.tags.replace': { words: 'changed a workflow’s tags' },
  'workflow.tag.delete': { words: 'deleted a tag', tone: 'canceled' },
  'workflow.organization.move': { words: 'moved workflows between folders' },
  'workflow.organization.replace_tags': {
    words: 'changed the tags on several workflows',
  },
  'workflow.organization.tag_cleanup': { words: 'cleaned up unused tags' },
  'workflow.comment.created': { words: 'commented on a workflow' },
  'workflow.comment.replied': { words: 'replied to a comment' },
  'workflow.comment.edited': { words: 'edited a comment' },
  'workflow.comment.deleted': { words: 'deleted a comment', tone: 'canceled' },
  'workflow.comment.thread.changed': {
    words: 'resolved or reopened a comment thread',
  },
  'webhook.trigger.provision': { words: 'created a webhook endpoint' },
  'webhook.trigger.endpoint.rotate': { words: 'replaced a webhook address' },
  'webhook.trigger.secret.rotate': {
    words: 'replaced a webhook signing secret',
  },
  'webhook.trigger.authentication.configure': {
    words: 'changed how a webhook checks its senders',
  },
  'schedule_trigger.enabled': { words: 'turned a schedule on' },
  'schedule_trigger.disabled': { words: 'turned a schedule off' },
  'form.access_changed': { words: 'changed who can open a form' },
  'connection.created': { words: 'added a connection' },
  'connection.secret_rotated': { words: 'replaced a connection’s secret' },
  'connection.revoked': { words: 'revoked a connection', tone: 'canceled' },
  'connection.credential_accessed': {
    words: 'used a connection’s credential',
  },
  'connection.test_dispatched': { words: 'tested a connection' },
  'data.tables.create': { words: 'created a data table' },
  'data.tables.remove': { words: 'removed a data table', tone: 'canceled' },
  'data.tables.configure': { words: 'changed a data table’s settings' },
  'data.tables.schema.edit': { words: 'changed a data table’s columns' },
  'data.table_schema_changed': { words: 'changed a data table’s columns' },
  'data.tables.rows.import': { words: 'imported rows into a data table' },
  'data.tables.rows.write': { words: 'changed rows in a data table' },
  'workspace.created': { words: 'created the workspace' },
  'workspace.renamed': { words: 'renamed the workspace' },
  'workspace.deletion_requested': {
    words: 'scheduled the workspace for deletion',
    tone: 'canceled',
  },
  'workspace.deletion_restored': { words: 'kept the workspace' },
  'workspace.reactivated': { words: 'reactivated the workspace' },
  'workspace.governance_changed': {
    words: 'changed publishing approval or audit retention',
  },
  'workspace.promotion_target_changed': {
    words: 'changed where workflows are promoted',
  },
  'workspace.variables_changed': { words: 'changed workspace variables' },
  'workspace.auto_pause_settings_changed': {
    words: 'changed when workflows pause themselves',
  },
  'workspace.ownership_transferred': { words: 'handed over ownership' },
  'workspace.invitation_created': { words: 'invited someone' },
  'workspace.invitation_resent': { words: 'sent an invitation again' },
  'workspace.invitation_revoked': {
    words: 'withdrew an invitation',
    tone: 'canceled',
  },
  'workspace.invitation_accepted': { words: 'accepted an invitation' },
  'workspace.member_added': { words: 'added a member' },
  'workspace.member_role_changed': { words: 'changed a member’s role' },
  'workspace.member_suspended': {
    words: 'suspended a member',
    tone: 'canceled',
  },
  'workspace.member_reactivated': { words: 'let a suspended member back in' },
  'workspace.member_removed': { words: 'removed a member', tone: 'canceled' },
  'workspace.member_left': { words: 'left the workspace' },
  'identity.session_signed_in': { words: 'signed in with single sign-on' },
  'identity.provider_tested': { words: 'tested a sign-in provider' },
  'identity.recovery_authorized': {
    words: 'signed in with the owner’s recovery password',
    tone: 'attention',
  },
  'identity.membership_projected': {
    words: 'updated someone’s access from the directory',
  },
  'identity.directory_membership_detached': {
    words: 'took someone’s access out of the directory’s hands',
  },
  'api.token.created': { words: 'created an API token' },
  'api.token.revoked': { words: 'revoked an API token', tone: 'canceled' },
  'pending_task.decided': { words: 'answered an approval' },
  'pending_task.submitted': { words: 'sent the input a run asked for' },
};

/** "schedule.admission_throttled" → "schedule admission throttled". */
function spokenAction(action: string): string {
  return action.replaceAll(/[._:-]+/gu, ' ').trim();
}

const SOURCES: Readonly<Record<string, string>> = {
  invitation: 'from an invitation',
  jit: 'at their first single sign-on',
  directory: 'from the directory',
};

function roleName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.charAt(0).toUpperCase() + value.slice(1)
    : undefined;
}

/** The few facts worth reading in the sentence itself. */
function particulars(event: AuditEvent): string[] {
  const facts: string[] = [];
  const { metadata } = event;
  if (typeof metadata.versionNumber === 'number')
    facts.push(`v${String(metadata.versionNumber)}`);
  const from = roleName(metadata.fromRole);
  const to = roleName(metadata.toRole);
  if (from !== undefined && to !== undefined) facts.push(`${from} → ${to}`);
  else {
    const role = roleName(metadata.role);
    if (role !== undefined) facts.push(`as ${role}`);
  }
  if (typeof metadata.source === 'string') {
    const source = SOURCES[metadata.source];
    if (source !== undefined) facts.push(source);
  }
  if (typeof metadata.affected === 'number')
    facts.push(
      `${String(metadata.affected)} row${metadata.affected === 1 ? '' : 's'}`,
    );
  if (Array.isArray(metadata.changedNames) && metadata.changedNames.length > 0)
    facts.push(metadata.changedNames.join(', '));
  return facts;
}

export type AuditSentence = Readonly<{
  actor: string;
  words: string;
  particulars: readonly string[];
  tone: StatusTone;
  /** The phrase came from the table; otherwise the action is read out. */
  known: boolean;
}>;

/** What an action did, in the ledger's words. */
export function auditActionWords(action: string): string {
  return PHRASES[action]?.words ?? `recorded “${spokenAction(action)}”`;
}

/** One audit event as a sentence: who, what they did, and its particulars. */
export function describeAuditEvent(event: AuditEvent): AuditSentence {
  const phrase = PHRASES[event.action];
  return {
    actor:
      event.actorName ??
      (event.actorId === null ? 'Pertexo' : 'A former member'),
    words: auditActionWords(event.action),
    particulars: particulars(event),
    tone: phrase?.tone ?? 'neutral',
    known: phrase !== undefined,
  };
}

/** What kind of thing each filter choice narrows the log to. */
export const AUDIT_SUBJECTS = [
  { value: 'workflow', label: 'Workflows' },
  { value: 'webhook_trigger', label: 'Webhooks' },
  { value: 'connection', label: 'Connections' },
  { value: 'data_table', label: 'Data tables' },
  { value: 'workspace_member', label: 'People' },
  { value: 'workspace', label: 'Workspace settings' },
  { value: 'identity_organization', label: 'Single sign-on' },
] as const;

/** The audit fields shown in an entry's details, in reading order. */
export const DETAIL_LABELS: Readonly<Record<string, string>> = {
  versionNumber: 'Version',
  revision: 'Revision',
  role: 'Role',
  fromRole: 'Role before',
  toRole: 'Role after',
  status: 'Status',
  source: 'Added',
  operation: 'Change',
  affected: 'Rows',
  changedCount: 'Variables changed',
  auditRetentionDays: 'Retention (days)',
  requirePublishApproval: 'Approval required',
  actorKind: 'Done by',
  workflowId: 'Workflow ID',
  versionId: 'Version ID',
  runId: 'Run ID',
  userId: 'Person ID',
  requestId: 'Request ID',
  publicationRequestId: 'Review ID',
  invitationId: 'Invitation ID',
  organizationId: 'Organization ID',
  directoryUserId: 'Directory person ID',
  credentialId: 'Directory token ID',
};
