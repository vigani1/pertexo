import { IssuesList } from '@/features/workflow-publish/workflow-publish-views.public';
import {
  groupWorkflowIssues,
  type WorkflowValidationTarget,
} from '@/features/workflow-publish/public';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import type {
  DraftProposalResult,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import {
  describeStepChange,
  diffWorkflowGraphs,
  graphSteps,
} from '@/features/workflow-drafts/public';

type DraftNode = WorkflowGraphContract['nodes'][number];

export function DraftProposalReview({
  result,
  graph,
  onFix,
}: Readonly<{
  result: Extract<DraftProposalResult, { kind: 'inspected' | 'rejected' }>;
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const proposedGraph =
    result.kind === 'inspected' ? result.draft.graph : EMPTY_WORKFLOW_GRAPH;
  const groups = groupWorkflowIssues(
    result.kind === 'inspected' ? result.validation : result,
    proposedGraph,
  );
  return (
    <div className="grid gap-4">
      {result.kind === 'inspected' ? (
        <DraftChanges before={result.base.graph} after={result.draft.graph} />
      ) : null}
      {groups.length > 0 ? (
        <section
          aria-labelledby="proposal-issues"
          className="rounded-md border p-3"
        >
          <h3 id="proposal-issues" className="text-sm font-medium">
            {result.kind === 'rejected'
              ? 'Proposal issues'
              : 'Publication issues'}
          </h3>
          <div className="mt-2">
            <IssuesList
              groups={groups}
              graph={proposedGraph}
              fixableGraph={graph}
              onFix={onFix}
            />
          </div>
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
      items: diff.changed.map(({ before: previous, after: node, aspects }) => {
        const details = [
          describeStepChange(
            aspects.filter((aspect) => aspect !== 'configVersion'),
          ),
          ...(aspects.includes('configVersion')
            ? [
                `Configuration version ${String(previous.configVersion)} → ${String(node.configVersion)}`,
              ]
            : []),
        ].filter(Boolean);
        return { id: node.id, text: [name(node), ...details].join(' · ') };
      }),
    },
    { label: 'Links added', items: linkChanges(after, diff.addedLinks, name) },
    {
      label: 'Links removed',
      items: linkChanges(before, diff.removedLinks, name),
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

function linkChanges(
  graph: WorkflowGraphContract,
  links: ReturnType<typeof diffWorkflowGraphs>['addedLinks'],
  name: (node: DraftNode) => string,
) {
  if (links.length === 0) return [];
  const steps = new Map(
    graphSteps(graph).map(({ node }) => [node.id, name(node)]),
  );
  const endpoint = ({ nodeId, port }: (typeof links)[number]['source']) =>
    `${steps.get(nodeId) ?? nodeId} (${port})`;
  return links.map(({ source, target }) => ({
    id: JSON.stringify([
      source.nodeId,
      source.port,
      target.nodeId,
      target.port,
    ]),
    text: `${endpoint(source)} → ${endpoint(target)}`,
  }));
}
