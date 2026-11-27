import { Disclosure } from '@/components/ui/disclosure';
import { cn } from '@/lib/class-names';

// A read-only, keyboard-accessible JSON viewer for step outputs and test
// results. Values render as inert text; large collections are truncated.

const MAX_CHILDREN = 100;
const OPEN_DEPTH = 2;

function Scalar({ value }: Readonly<{ value: unknown }>) {
  if (value === null)
    return <span className="text-subtle-foreground">null</span>;
  if (typeof value === 'string')
    return <span className="break-all text-accent-foreground">“{value}”</span>;
  if (typeof value === 'number')
    return <span className="text-warning">{String(value)}</span>;
  if (typeof value === 'boolean')
    return <span className="text-secondary">{String(value)}</span>;
  return <span className="text-subtle-foreground">{typeof value}</span>;
}

function entriesOf(value: object): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
}

function Node({
  name,
  value,
  depth,
}: Readonly<{ name: string | undefined; value: unknown; depth: number }>) {
  const label =
    name === undefined ? null : (
      <span className="text-muted-foreground">{name}: </span>
    );
  if (value === null || typeof value !== 'object')
    return (
      <div className="py-0.5 pl-4">
        {label}
        <Scalar value={value} />
      </div>
    );
  const entries = entriesOf(value);
  const summary = Array.isArray(value)
    ? `[${String(entries.length)}]`
    : `{${String(entries.length)}}`;
  return (
    <Disclosure
      defaultOpen={depth < OPEN_DEPTH}
      appearance={{ look: 'tree' }}
      summary={
        <>
          {label}
          <span className="text-subtle-foreground">{summary}</span>
        </>
      }
    >
      {entries.slice(0, MAX_CHILDREN).map(([key, child]) => (
        <Node key={key} name={key} value={child} depth={depth + 1} />
      ))}
      {entries.length > MAX_CHILDREN ? (
        <div className="py-0.5 pl-4 text-subtle-foreground">
          +{String(entries.length - MAX_CHILDREN)} more
        </div>
      ) : null}
    </Disclosure>
  );
}

export function JsonTree({
  value,
  label,
  className,
}: Readonly<{ value: unknown; label: string; className?: string }>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'max-h-96 overflow-auto rounded-md border border-border bg-recess-ink/25 p-2 font-mono text-xs leading-relaxed',
        className,
      )}
    >
      <Node name={undefined} value={value} depth={0} />
    </div>
  );
}
