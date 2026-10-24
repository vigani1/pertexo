import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import {
  diffWorkflowGraphs,
  isEmptyDiff,
} from '@/features/workflows/comparison.public';
import { Checkbox } from '@/components/ui/checkbox';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { Disclosure } from '@/components/ui/disclosure';
export function PromotionReview({
  review,
  acknowledged,
  locked,
  onAcknowledge,
}: {
  review: WorkflowPromotionPreview;
  acknowledged: readonly string[];
  locked: boolean;
  onAcknowledge: (id: string, checked: boolean) => void;
}) {
  const acknowledgedIds = new Set(acknowledged);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3 border-y border-border py-4 text-sm">
        <span>{review.sourceWorkspaceName}</span>
        <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-action/40" />
        <Status tone={review.compatible ? 'success' : 'attention'}>
          {review.targetWorkspaceName}
        </Status>
      </div>
      <p className="text-sm text-muted-foreground">
        Only workflow definitions move. Target credentials, variable values,
        table rows and access settings stay in the target workspace.
      </p>
      {review.workflows.map((workflow) => {
        const diff = diffWorkflowGraphs(
          workflow.targetGraph ?? EMPTY_WORKFLOW_GRAPH,
          workflow.proposedGraph,
        );
        return (
          <article
            key={workflow.sourceWorkflowId}
            className="grid gap-3 rounded-lg border border-border p-4"
          >
            <h3 className="break-words font-semibold">
              {workflow.sourceName}{' '}
              <span className="font-mono text-xs text-muted-foreground">
                v{String(workflow.sourceVersionNumber)}
              </span>
            </h3>
            <p className="text-sm text-muted-foreground">
              {workflow.targetWorkflowId === null
                ? 'Creates a new target workflow.'
                : `Updates target draft r${String(workflow.targetRevision)}.`}
            </p>
            {workflow.targetWorkflowId !== null &&
            workflow.targetName !== workflow.sourceName ? (
              <p className="text-sm">
                Rename {workflow.targetName} to {workflow.sourceName}.
              </p>
            ) : null}
            {isEmptyDiff(diff) ? (
              <p className="text-sm text-muted-foreground">
                No definition changes; only canvas positions may differ.
              </p>
            ) : (
              <ul className="list-inside list-disc text-sm">
                {diff.lines.map((line) => (
                  <li key={`${line.target}:${line.id}`}>
                    {CHANGE_LABELS[line.kind]} {line.label}
                    {line.detail === undefined ? '' : ` · ${line.detail}`}
                  </li>
                ))}
              </ul>
            )}
            <Disclosure summary="Inspect proposed definition" tone="link">
              <pre
                className="max-h-72 overflow-auto rounded border border-border p-3 text-xs"
                tabIndex={0}
              >
                {JSON.stringify(workflow.proposedGraph, null, 2)}
              </pre>
            </Disclosure>
            {workflow.directChanges ? (
              <Notice tone="warning">
                <p>
                  The target was edited directly since its last promotion.
                  Applying replaces its draft and name with this reviewed
                  definition.
                </p>
                <label className="mt-3 flex items-start gap-2">
                  <Checkbox
                    checked={acknowledgedIds.has(workflow.sourceWorkflowId)}
                    disabled={locked}
                    onCheckedChange={(checked) => {
                      onAcknowledge(workflow.sourceWorkflowId, checked);
                    }}
                  />
                  <span>Replace these target changes</span>
                </label>
              </Notice>
            ) : null}
          </article>
        );
      })}
      <section aria-label="Target requirements" className="grid gap-2">
        <h3 className="font-semibold">Target requirements</h3>
        {review.requirements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections, variables, tables or child workflows are required.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {review.requirements.map((requirement) => (
              <li
                key={canonicalJson(requirement)}
                className="grid gap-2 py-3 sm:grid-cols-[7rem_1fr]"
              >
                <Status tone={REQUIREMENT_STATUS[requirement.status].tone}>
                  {REQUIREMENT_STATUS[requirement.status].label}
                </Status>
                <div className="min-w-0 break-words text-sm">
                  <p className="font-medium">
                    {requirement.kind}: {requirement.name}
                  </p>
                  <p className="text-muted-foreground">{requirement.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const CHANGE_LABELS = {
  added: 'Add',
  removed: 'Remove',
  changed: 'Change',
} as const;
const REQUIREMENT_STATUS = {
  ready: { tone: 'success', label: 'Ready' },
  warning: { tone: 'attention', label: 'Review' },
  missing: { tone: 'failure', label: 'Needs setup' },
  incompatible: { tone: 'failure', label: 'Needs setup' },
} as const;
