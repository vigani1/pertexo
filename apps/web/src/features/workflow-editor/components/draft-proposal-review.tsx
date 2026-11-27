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
import type { ReactNode } from 'react';
import { StatusMark } from '@/components/patterns/status/status-mark';
import {
  describeStepChange,
  diffWorkflowGraphs,
  graphSteps,
  type DraftFieldChange,
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
      <PublicationCheck
        result={result}
        groups={groups}
        proposedGraph={proposedGraph}
        graph={graph}
        onFix={onFix}
      />
    </div>
  );
}

/** The proposal's publication check: its issues, or that there are none. */
function PublicationCheck({
  result,
  groups,
  proposedGraph,
  graph,
  onFix,
}: Readonly<{
  result: Extract<DraftProposalResult, { kind: 'inspected' | 'rejected' }>;
  groups: ReturnType<typeof groupWorkflowIssues>;
  proposedGraph: WorkflowGraphContract;
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  if (groups.length === 0)
    return result.kind === 'inspected' ? (
      <StatusMark tone="success">No publication issues</StatusMark>
    ) : null;
  return (
    <section aria-labelledby="proposal-issues">
      <h3 id="proposal-issues" className="text-sm font-medium">
        {result.kind === 'rejected' ? 'Proposal issues' : 'Publication issues'}
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
  const groups: readonly {
    label: string;
    glyph: string;
    items: readonly { id: string; text: string; fields?: ReactNode }[];
  }[] = [
    {
      label: 'Added',
      glyph: '+',
      items: diff.added.map((node) => ({ id: node.id, text: name(node) })),
    },
    {
      label: 'Removed',
      glyph: '−',
      items: diff.removed.map((node) => ({ id: node.id, text: name(node) })),
    },
    {
      label: 'Changed',
      glyph: '~',
      items: diff.changed.map(
        ({ before: previous, after: node, aspects, settings, mappings }) => {
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
          return {
            id: node.id,
            text: [name(node), ...details].join(' · '),
            fields: (
              <>
                <ChangedFields
                  label="Settings"
                  fields={settings}
                  format={formatValue}
                />
                <ChangedFields
                  label="Input mappings"
                  fields={mappings}
                  format={(mapping) =>
                    formatValue(
                      mapping?.kind === 'literal' ? mapping.value : mapping,
                    )
                  }
                />
              </>
            ),
          };
        },
      ),
    },
    {
      label: 'Links added',
      glyph: '→',
      items: linkChanges(after, diff.addedLinks, name),
    },
    {
      label: 'Links removed',
      glyph: '×',
      items: linkChanges(before, diff.removedLinks, name),
    },
  ];
  return (
    <section
      aria-labelledby="proposal-changes"
      className="grid min-w-0 gap-2 text-sm"
    >
      <h3 id="proposal-changes" className="font-medium">
        Draft changes
      </h3>
      {groups
        .filter(({ items }) => items.length > 0)
        .map(({ label, glyph, items }) => (
          <div key={label}>
            <h4 className="text-meta font-medium text-muted-foreground">
              {label}
            </h4>
            <ul className="divide-y divide-border">
              {items.map(({ id, text, fields }) => (
                <li
                  key={id}
                  className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-2 py-2 [overflow-wrap:anywhere]"
                >
                  <span
                    aria-hidden="true"
                    className="font-mono text-subtle-foreground"
                  >
                    {glyph}
                  </span>
                  <div className="min-w-0">
                    {text}
                    {fields}
                  </div>
                </li>
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

function ChangedFields<Value>({
  label,
  fields,
  format,
}: Readonly<{
  label: string;
  fields: readonly DraftFieldChange<Value>[];
  format: (value: Value | undefined) => string;
}>) {
  if (fields.length === 0) return null;
  return (
    <div className="my-2 grid min-w-0 gap-1.5 rounded-md border px-3 py-2">
      <h5 className="text-xs font-medium text-muted-foreground">{label}</h5>
      <dl className="grid min-w-0 gap-2">
        {fields.map(({ name, before, after }) => (
          <div key={name} className="grid min-w-0 gap-1">
            <dt className="font-medium text-foreground">{name}</dt>
            <dd className="grid min-w-0 gap-1 text-xs sm:grid-cols-2">
              <ChangeValue label="Before" value={format(before)} />
              <ChangeValue label="After" value={format(after)} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ChangeValue({
  label,
  value,
}: Readonly<{ label: string; value: string }>) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span>{label}</span>
      <code className="max-h-36 overflow-auto rounded-sm bg-muted px-1.5 py-0.5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        {value}
      </code>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'Unset';
  if (value === '') return 'Empty string';
  return typeof value === 'string' ? value : JSON.stringify(value);
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
