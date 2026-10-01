import { useMemo } from 'react';

/** Unlike JsonTree, source review must never truncate any graph value. */
export function PortableGraphReview({
  graph,
  label,
}: Readonly<{ graph: unknown; label: string }>) {
  const json = useMemo(() => JSON.stringify(graph, null, 2), [graph]);
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-80 overflow-auto overscroll-contain rounded-md border border-border bg-black/25 p-3 font-mono text-xs whitespace-pre-wrap break-all focus-ring"
    >
      {json}
    </pre>
  );
}
