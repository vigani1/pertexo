import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { cn } from '@/lib/utils';
import { diffWorkflowGraphs, isEmptyDiff } from '../../model/version-diff';

function ChangeList({
  title,
  items,
  tone,
}: Readonly<{
  title: string;
  items: readonly string[];
  tone: 'added' | 'removed' | 'changed';
}>) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h4
        className={cn(
          'text-xs font-semibold',
          tone === 'added' && 'text-success',
          tone === 'removed' && 'text-destructive',
          tone === 'changed' && 'text-warning',
        )}
      >
        {title}
      </h4>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => (
          <li key={`${item}-${String(index)}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What changed from one version to another, by step: added, removed or
 * changed, plus whether the connections between steps changed. Works on any
 * two versions, in either order.
 */
export function VersionDiffSummary({
  from,
  to,
}: Readonly<{
  from: WorkflowVersionResponse;
  to: WorkflowVersionResponse;
}>) {
  const diff = diffWorkflowGraphs(from.graph, to.graph);
  const since = `v${String(from.versionNumber)}`;
  if (isEmptyDiff(diff))
    return (
      <p className="text-sm text-muted-foreground">
        Same steps as {since}. Only positions on the canvas moved, if anything.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <ChangeList title="Added" items={diff.added} tone="added" />
      <ChangeList title="Removed" items={diff.removed} tone="removed" />
      <ChangeList title="Changed" items={diff.changed} tone="changed" />
      {diff.connectionsChanged ? (
        <p className="text-sm text-muted-foreground">
          How the steps connect changed since {since}.
        </p>
      ) : null}
    </div>
  );
}
