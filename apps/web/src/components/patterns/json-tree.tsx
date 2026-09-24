import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

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
    <details open={depth < OPEN_DEPTH} className="group/json">
      <summary className="flex cursor-default list-none items-center gap-1 rounded-sm py-0.5 outline-none select-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-subtle-foreground transition-transform group-open/json:rotate-90 motion-reduce:transition-none"
        />
        {label}
        <span className="text-subtle-foreground">{summary}</span>
      </summary>
      <div className="ml-1.5 border-l border-border pl-1">
        {entries.slice(0, MAX_CHILDREN).map(([key, child]) => (
          <Node key={key} name={key} value={child} depth={depth + 1} />
        ))}
        {entries.length > MAX_CHILDREN ? (
          <div className="py-0.5 pl-4 text-subtle-foreground">
            +{String(entries.length - MAX_CHILDREN)} more
          </div>
        ) : null}
      </div>
    </details>
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
        'max-h-96 overflow-auto rounded-md border border-border bg-black/25 p-2 font-mono text-xs leading-relaxed',
        className,
      )}
    >
      <Node name={undefined} value={value} depth={0} />
    </div>
  );
}
