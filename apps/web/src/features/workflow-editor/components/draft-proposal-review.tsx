import type {
  DraftProposalResult,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import {
  describeStepChange,
  diffWorkflowGraphs,
} from '@/features/workflow-drafts/public';

type DraftNode = WorkflowGraphContract['nodes'][number];

export function DraftProposalReview({
  result,
}: Readonly<{
  result: Extract<DraftProposalResult, { kind: 'inspected' | 'rejected' }>;
}>) {
  const issues =
    result.kind === 'rejected' ? result.issues : result.validation.issues;
  const uniqueIssues = new Map(
    issues.map(({ code, path, message }) => [
      JSON.stringify([code, path, message]),
      message,
    ]),
  );
  return (
    <div className="grid gap-4">
      {result.kind === 'inspected' ? (
        <DraftChanges before={result.base.graph} after={result.draft.graph} />
      ) : null}
      {issues.length > 0 ? (
        <section
          aria-labelledby="proposal-issues"
          className="rounded-md border p-3"
        >
          <h3 id="proposal-issues" className="text-sm font-medium">
            {result.kind === 'rejected'
              ? 'Proposal issues'
              : 'Publication issues'}
          </h3>
          <ul className="mt-2 grid list-disc gap-1 pl-4 text-sm text-muted-foreground">
            {[...uniqueIssues].map(([key, message]) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function DraftChanges({
  before,
  after,
}: Readonly<{ before: WorkflowGraphContract; after: WorkflowGraphContract }>) {
  const diff = diffWorkflowGraphs(before, after);
  const name = (node: DraftNode) => {
    const label = node.label?.trim();
    return label === undefined || label === '' ? node.definition.key : label;
  };
  const groups = [
    {
      label: 'Added',
      items: diff.added.map((node) => ({ id: node.id, text: name(node) })),
    },
    {
      label: 'Removed',
      items: diff.removed.map((node) => ({ id: node.id, text: name(node) })),
    },
    {
      label: 'Changed',
      items: diff.changed.map(({ after: node, aspects }) => ({
        id: node.id,
        text: `${name(node)} · ${describeStepChange(aspects)}`,
      })),
    },
  ];
  return (
    <section aria-labelledby="proposal-changes" className="grid gap-2 text-sm">
      <h3 id="proposal-changes" className="font-medium">
        Draft changes
      </h3>
      {groups
        .filter(({ items }) => items.length > 0)
        .map(({ label, items }) => (
          <div key={label}>
            <h4 className="font-medium">{label}</h4>
            <ul className="text-muted-foreground">
              {items.map(({ id, text }) => (
                <li key={id}>{text}</li>
              ))}
            </ul>
          </div>
        ))}
      {diff.linksAdded > 0 || diff.linksRemoved > 0 ? (
        <p className="text-muted-foreground">
          Links added {diff.linksAdded} · Links removed {diff.linksRemoved}
        </p>
      ) : null}
      {diff.notes.map(({ id, kind, label }) => (
        <p key={id}>
          Note {kind} · {label}
        </p>
      ))}
      {JSON.stringify(before.settings) !== JSON.stringify(after.settings) ? (
        <p>Workflow settings changed.</p>
      ) : null}
      {JSON.stringify(before.callable) !== JSON.stringify(after.callable) ? (
        <p>Workflow contract changed.</p>
      ) : null}
    </section>
  );
}
