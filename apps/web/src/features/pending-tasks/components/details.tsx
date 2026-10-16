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
            {Array.isArray(value) ? (
              <PlainDetailList values={value} />
            ) : value === null ? (
              '—'
            ) : (
              String(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PlainDetailList({
  values,
}: Readonly<{ values: readonly (string | number | boolean | null)[] }>) {
  if (values.length === 0) return <>—</>;
  const occurrences = new Map<string, number>();
  const items = values.map((value) => {
    const identity = JSON.stringify(value);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      key: `${identity}:${String(occurrence)}`,
      text: value === null ? '—' : String(value),
    };
  });
  return (
    <ul className="list-disc pl-5">
      {items.map((item) => (
        <li key={item.key}>{item.text}</li>
      ))}
    </ul>
  );
}
