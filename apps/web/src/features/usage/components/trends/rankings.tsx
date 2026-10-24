import { Link } from '@tanstack/react-router';
import type { UsageTrendsResponse } from '@pertexo/contracts';
import { FORMAT_LOCALE } from '@/lib/format/locale';
export function WorkflowRankings({
  items,
  metric,
  workspaceId,
  canOpen,
}: Readonly<{
  items: UsageTrendsResponse['busiest'];
  metric: 'runs' | 'failures';
  workspaceId: string;
  canOpen: boolean;
}>) {
  return items.length === 0 ? (
    <p className="text-sm text-muted-foreground">
      {metric === 'failures'
        ? 'No failures in this period.'
        : 'No runs in this period.'}
    </p>
  ) : (
    <ol className="divide-y divide-border">
      {items.map((item) => (
        <li
          key={item.workflowId}
          className="flex items-center justify-between gap-4 py-3 text-sm"
        >
          <span className="min-w-0 truncate">
            {canOpen ? (
              <Link
                className="underline underline-offset-4"
                to="/w/$workspaceId/workflows/$workflowId"
                params={{ workspaceId, workflowId: item.workflowId }}
              >
                {item.workflowName ?? 'Workflow'}
              </Link>
            ) : (
              'Workflow'
            )}
          </span>
          <span className="shrink-0 tabular-nums">
            {item[metric].toLocaleString(FORMAT_LOCALE)}{' '}
            {metricNoun(metric, item[metric])}
          </span>
        </li>
      ))}
    </ol>
  );
}

function metricNoun(metric: 'runs' | 'failures', count: number): string {
  if (count !== 1) return metric;
  return metric === 'runs' ? 'run' : 'failure';
}
