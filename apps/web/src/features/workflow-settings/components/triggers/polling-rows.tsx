import {
  DATABASE_POLL_TRIGGER,
  HTTP_POLL_TRIGGER,
} from '@pertexo/workflow-model';
import type { PollingTriggerHealth } from '@pertexo/contracts';
import { StepTile } from '@/features/catalog/catalog-views.public';
import { describeStep } from '@/features/catalog/public';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { StatusTone } from '@/components/patterns/status/status-mark';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { TriggerRow } from './trigger-row';
import {
  databasePollingGuidance,
  pollingGuidance,
} from '@/lib/polling-guidance';

const failureCopy: Record<string, string | undefined> = {
  'database.address_blocked':
    'The outbound network policy blocked the database address.',
  'database.tls_failed': 'Check the database TLS settings and certificate.',
  'database.connection_refused': 'The database refused the connection.',
  'database.connection_failed': 'Check that the database is reachable.',
  'database.authentication_failed':
    'Repair the PostgreSQL connection, then resume triggers.',
  'database.timeout': 'The database took too long to respond.',
  'database.invalid_columns':
    'Check the schema, table and column names against PostgreSQL.',
  'database.key_not_unique':
    'Choose a non-null key column with a unique index.',
  'database.poll_invalid_key':
    'Check that each row has a usable key and ordering value.',
  'database.result_limit': 'The fetched rows exceed the result size limit.',
  'database.row_limit': 'The database returned too many rows.',
  'database.query_failed':
    'PostgreSQL could not read the configured rows. Check table access and the ordering column.',
  'database.poll_rate_limited':
    'The PostgreSQL connection is limiting requests.',
  'http.poll_invalid_page': 'The feed did not return a readable JSON page.',
  'http.poll_invalid_items': 'The items path must point to a JSON array.',
  'http.poll_invalid_key':
    'Every item needs a non-empty string or a finite number at its key path.',
  'http.poll_navigation_denied':
    'The feed URL or a next page was blocked. Keep all pages at the same origin.',
  'http.poll_authentication':
    'The feed could not be authenticated. Repair the connection or check the feed’s access settings, then resume triggers.',
  'http.poll_rate_limited': 'The feed is limiting requests.',
  'http.poll_deadline_exceeded': 'The feed took too long to respond.',
  'http.poll_response_failed': 'The feed returned an unsuccessful response.',
  'http.poll_request_failed': 'The feed could not be reached.',
};

/** The published version's polling triggers, one row each. */
export function PollingRows({
  title,
  triggers,
  stepNameFor,
}: Readonly<{
  title: string;
  triggers: readonly PollingTriggerHealth[];
  stepNameFor: (trigger: PollingTriggerHealth) => string;
}>) {
  if (triggers.length === 0)
    return (
      <TriggerRow
        label={title}
        icon={<StepTile step={describeStep(pollingStepKey(title))} />}
        name={title}
        kind="Polling · checks for changes and starts a run for each new item"
        state={
          <StatusMark tone="queued">Waiting for its first check</StatusMark>
        }
      />
    );
  return triggers.map((trigger) => (
    <PollingRow
      key={trigger.id}
      title={title}
      trigger={trigger}
      name={stepNameFor(trigger)}
    />
  ));
}

function PollingRow({
  title,
  trigger,
  name,
}: Readonly<{
  title: string;
  trigger: PollingTriggerHealth;
  name: string;
}>) {
  const guidance = trigger.lastErrorCode?.startsWith('database.')
    ? databasePollingGuidance
    : pollingGuidance;
  const reason =
    trigger.lastErrorCode === null
      ? null
      : (failureCopy[trigger.lastErrorCode] ??
        'The polling trigger could not be activated.');
  const next =
    trigger.paused || trigger.healthStatus === 'disabled'
      ? null
      : trigger.nextPollAt;
  const status = pollStatus(trigger);
  return (
    <TriggerRow
      label={`${title}: ${name}`}
      icon={<StepTile step={describeStep(pollingStepKey(title))} />}
      name={name}
      kind={`${title} · checks for changes and starts a run for each new item`}
      state={
        <>
          <StatusMark tone={status.tone}>{status.label}</StatusMark>
          {next === null ? null : (
            <span className="text-meta text-subtle-foreground">
              Next check{' '}
              <time dateTime={next} title={formatDateTime(next)}>
                {formatRelativeTime(next)}
              </time>
            </span>
          )}
        </>
      }
      extra={
        reason === null ? undefined : (
          <Notice tone="warning" className="mt-2">
            <p>{reason}</p>
            <p>
              {trigger.baselineEstablished
                ? 'Resuming keeps the items already recorded.'
                : guidance.baseline}
            </p>
            <p>
              {guidance.keys} {guidance.retention} {guidance.interval}
            </p>
          </Notice>
        )
      }
    />
  );
}

function pollingStepKey(title: string): string {
  return title === 'Database Row'
    ? DATABASE_POLL_TRIGGER.key
    : HTTP_POLL_TRIGGER.key;
}

function pollStatus(
  trigger: PollingTriggerHealth,
): Readonly<{ tone: StatusTone; label: string }> {
  if (trigger.healthStatus === 'disabled')
    return { tone: 'off', label: 'Disabled' };
  if (trigger.paused) return { tone: 'off', label: 'Paused' };
  if (trigger.healthStatus === 'healthy')
    return { tone: 'success', label: 'Healthy' };
  if (trigger.lastErrorCode !== null)
    return { tone: 'attention', label: 'Check failed' };
  return {
    tone: 'queued',
    label: trigger.baselineEstablished
      ? 'Waiting for its next check'
      : 'Waiting for its first check',
  };
}
