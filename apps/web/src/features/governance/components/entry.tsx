import type { AuditEvent } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { RecentLogEntry } from '@/components/patterns/lists/recent-log';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDateTime } from '@/lib/format/time';
import { DETAIL_LABELS, describeAuditEvent } from '../model/ledger';
import { Disclosure } from '@/components/ui/disclosure';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Where the changed thing lives, when it has a page of its own. */
function TargetLink({
  workspaceId,
  event,
}: Readonly<{ workspaceId: string; event: AuditEvent }>) {
  const className = 'inline-link py-0.5 text-xs';
  const workflowId = workflowTarget(event);
  if (workflowId !== null)
    return (
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId }}
        className={className}
      >
        Open workflow
      </Link>
    );
  if (event.targetType === 'data_table' && event.targetId !== null)
    return (
      <Link
        to="/w/$workspaceId/data-tables/$tableId"
        params={{ workspaceId, tableId: event.targetId }}
        className={className}
      >
        Open table
      </Link>
    );
  if (event.targetType === 'workspace_member')
    return (
      <Link
        to="/w/$workspaceId/team"
        params={{ workspaceId }}
        className={className}
      >
        Open team
      </Link>
    );
  if (event.targetType === 'connection')
    return (
      <Link
        to="/w/$workspaceId/connections"
        params={{ workspaceId }}
        className={className}
      >
        Open connections
      </Link>
    );
  return null;
}

function DetailValue({
  value,
}: Readonly<{ value: AuditEvent['metadata'][string] }>) {
  if (typeof value === 'string' && uuid.test(value))
    return (
      <CopyButton
        value={value}
        display={`${value.slice(0, 8)}…`}
        label="Copy ID"
      />
    );
  if (Array.isArray(value)) return <>{value.join(', ')}</>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  return <>{String(value)}</>;
}

/**
 * An audit event read as a sentence. Its details keep the IDs support asks
 * for, and narrowing to "only this" starts from here.
 */
export function AuditEntry({
  workspaceId,
  event,
  onOnlyAction,
  onOnlyTarget,
}: Readonly<{
  workspaceId: string;
  event: AuditEvent;
  onOnlyAction: (action: string) => void;
  onOnlyTarget: (targetType: string, targetId: string) => void;
}>) {
  const sentence = describeAuditEvent(event);
  const details = Object.entries(event.metadata).filter(
    ([name]) => DETAIL_LABELS[name] !== undefined,
  );
  return (
    <RecentLogEntry
      tone={sentence.tone}
      at={event.occurredAt}
      label={
        <span className="font-normal text-muted-foreground [overflow-wrap:anywhere]">
          <b className="font-medium text-foreground">{sentence.actor}</b>{' '}
          {sentence.words}
          {sentence.particulars.length === 0 ? null : (
            <span className="text-subtle-foreground">
              {' · '}
              {sentence.particulars.join(' · ')}
            </span>
          )}
        </span>
      }
      action={
        <div className="mt-1 flex flex-wrap items-start gap-x-3 gap-y-1">
          <TargetLink workspaceId={workspaceId} event={event} />
          <Disclosure
            summary="Details"
            size="xs"
            className="text-xs text-muted-foreground"
          >
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt>When</dt>
              <dd className="font-mono text-[0.72rem]">
                {formatDateTime(event.occurredAt)}
              </dd>
              <dt>Recorded as</dt>
              <dd className="font-mono text-[0.72rem] [overflow-wrap:anywhere]">
                {event.action}
              </dd>
              {details.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt>{DETAIL_LABELS[name]}</dt>
                  <dd className="min-w-0 font-mono text-[0.72rem] [overflow-wrap:anywhere]">
                    <DetailValue value={value} />
                  </dd>
                </div>
              ))}
              <dt>Event ID</dt>
              <dd>
                <DetailValue value={event.id} />
              </dd>
            </dl>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOnlyAction(event.action);
                }}
              >
                Only this kind of event
              </Button>
              {event.targetId === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (event.targetId !== null)
                      onOnlyTarget(event.targetType, event.targetId);
                  }}
                >
                  Only this item
                </Button>
              )}
            </div>
          </Disclosure>
        </div>
      }
    />
  );
}

function workflowTarget(event: AuditEvent): string | null {
  if (event.targetType === 'workflow') return event.targetId;
  return typeof event.metadata.workflowId === 'string'
    ? event.metadata.workflowId
    : null;
}
