import { useStepDescriptions } from '@/features/catalog/public';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import { Row, RowList } from '@/components/patterns/lists/row';
import { diffWorkflowGraphs, isEmptyDiff } from '@/features/workflows/public';

const MARKS = { added: '+', removed: '−', changed: '~' } as const;

type Change = Readonly<{
  key: string;
  label: string;
  detail?: string;
  kind: keyof typeof MARKS;
}>;

/** One change per row: its mark, the step and what happened to it. */
function ChangeRows({ changes }: Readonly<{ changes: readonly Change[] }>) {
  return (
    <RowList aria-label="Changes">
      {changes.map((change) => (
        <Row
          key={change.key}
          lift="none"
          className="grid-cols-[1.25rem_minmax(0,1fr)_auto] py-2.5"
        >
          <span aria-hidden="true" className="font-mono text-subtle-foreground">
            {MARKS[change.kind]}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {change.label}
            </span>
            {change.detail === undefined ? null : (
              <span className="block text-meta text-subtle-foreground">
                {change.detail}
              </span>
            )}
          </span>
          <span className="font-mono text-micro tracking-[0.08em] text-subtle-foreground uppercase">
            {change.kind}
          </span>
        </Row>
      ))}
    </RowList>
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
  const describeStep = useStepDescriptions();
  const diff = diffWorkflowGraphs(from.graph, to.graph, describeStep);
  const since = `v${String(from.versionNumber)}`;
  if (isEmptyDiff(diff))
    return (
      <p className="text-sm text-muted-foreground">
        Same steps as {since}. Only positions on the canvas moved, if anything.
      </p>
    );
  const changes: Change[] = [
    ...(['added', 'removed', 'changed'] as const).flatMap((kind) =>
      diff[kind].map((item) => ({
        key: `step:${item.id}`,
        label: item.label,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        kind,
      })),
    ),
    ...diff.notes.map((note) => ({
      key: `note:${note.id}`,
      label: note.label,
      detail: 'Note',
      kind: note.kind,
    })),
  ];
  return (
    <div className="flex flex-col gap-3">
      <ChangeRows changes={changes} />
      {diff.contractChanged ? (
        <p className="text-meta text-subtle-foreground">
          Input or callable contract changed since {since}.
        </p>
      ) : null}
      {diff.settingsChanged ? (
        <p className="text-meta text-subtle-foreground">
          Workflow execution settings changed since {since}.
        </p>
      ) : null}
      {diff.linksChanged ? (
        <p className="text-meta text-subtle-foreground">
          How the steps connect changed since {since}.
        </p>
      ) : null}
    </div>
  );
}
