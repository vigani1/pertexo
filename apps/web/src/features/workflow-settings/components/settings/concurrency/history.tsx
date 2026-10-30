import {
  WORKFLOW_CONCURRENCY_RECENT_SKIPS_MAX,
  type WorkflowConcurrencySettings,
} from '@pertexo/contracts';
import { Status } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format/time';
const labels = {
  webhook: 'Webhook',
  schedule: 'Schedule',
  form: 'Form',
  workflow_error: 'Error workflow',
};
export function SkipHistory({
  items,
}: Readonly<{
  items: NonNullable<WorkflowConcurrencySettings['recentSkips']>;
}>) {
  return (
    <section className="space-y-3" aria-label="Recent skipped triggers">
      <h3 className="text-sm font-medium">Recent skipped triggers</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing skipped in the last 90 days.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
            >
              <span>
                <Status tone="skipped">
                  {labels[item.triggerType]} skipped
                </Status>
                <span className="mt-1 block text-muted-foreground">
                  Concurrency limit reached. No run started.
                </span>
              </span>
              <time
                dateTime={item.at}
                className="text-xs text-muted-foreground"
              >
                {formatDateTime(item.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {items.length === WORKFLOW_CONCURRENCY_RECENT_SKIPS_MAX ? (
        <p className="text-xs text-muted-foreground">
          Showing the latest {WORKFLOW_CONCURRENCY_RECENT_SKIPS_MAX}. Usage
          includes all retained skips.
        </p>
      ) : null}
    </section>
  );
}
