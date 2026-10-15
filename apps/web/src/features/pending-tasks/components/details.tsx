import type { PendingTaskSummary } from '@pertexo/contracts';

export function TaskDetails({
  details,
}: Readonly<{ details: PendingTaskSummary['details'] }>) {
  const entries = Object.entries(details);
  if (entries.length === 0) return null;
  return (
    <dl aria-label="Request details" className="mt-4 grid min-w-0 gap-3">
      {entries.map(([name, value]) => (
        <div key={name} className="min-w-0">
          <dt className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {name}
          </dt>
          <dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
            {value === null ? '—' : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
