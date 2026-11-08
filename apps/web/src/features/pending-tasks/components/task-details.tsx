import type { PendingTaskSummary } from '@pertexo/contracts';

type Details = PendingTaskSummary['details'];

/** A request's details as a grid of named values, for its own page. */
export function TaskDetails({ details }: Readonly<{ details: Details }>) {
  const entries = Object.entries(details);
  if (entries.length === 0) return null;
  return (
    <dl
      aria-label="Request details"
      className="grid min-w-0 gap-x-8 gap-y-5 sm:grid-cols-2"
    >
      {entries.map(([name, value]) => (
        <div key={name} className="min-w-0">
          <dt className="text-xs whitespace-pre-wrap break-words text-subtle-foreground [overflow-wrap:anywhere]">
            {name}
          </dt>
          <dd className="mt-1 text-base whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            <DetailValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A request's details on one or two lines of a list: "Amount 120 ·
 * Customer Ada Lovelace". The request page shows them in full.
 */
export function TaskDetailsLine({ details }: Readonly<{ details: Details }>) {
  const entries = Object.entries(details);
  if (entries.length === 0) return null;
  return (
    <p className="line-clamp-2 min-w-0 text-sm [overflow-wrap:anywhere]">
      {entries.map(([name, value], index) => (
        <span key={name}>
          {index === 0 ? null : (
            <span aria-hidden="true" className="text-subtle-foreground">
              {' · '}
            </span>
          )}
          <span className="text-subtle-foreground">{name} </span>
          {Array.isArray(value) && value.length > 0 ? (
            // Each chosen item reads on its own, as on the request page.
            value.map((item, itemIndex) => (
              <span
                // Items can repeat; their order is their identity here.
                key={itemIndex}
                className="text-foreground/90"
              >
                {itemIndex === 0 ? null : ', '}
                <span>{item === null ? '—' : String(item)}</span>
              </span>
            ))
          ) : (
            <span className="text-foreground/90">{detailText(value)}</span>
          )}
        </span>
      ))}
    </p>
  );
}

function detailText(value: Details[string]): string {
  if (Array.isArray(value))
    return value.length === 0
      ? '—'
      : value.map((item) => (item === null ? '—' : String(item))).join(', ');
  return value === null ? '—' : String(value);
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

function DetailValue({ value }: Readonly<{ value: Details[string] }>) {
  if (Array.isArray(value)) return <PlainDetailList values={value} />;
  return value === null ? '—' : String(value);
}
