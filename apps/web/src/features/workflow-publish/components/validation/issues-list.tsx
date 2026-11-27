import { readSchemaUnion } from '@pertexo/workflow-model';
import { schemaFields } from '@/lib/schema-fields/fields';
import { fieldLabel } from '@/lib/schema-fields/units';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { WrenchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { useStepDescriptions } from '@/features/catalog/public';
import { StepTile } from '@/features/catalog/catalog-views.public';
import type {
  WorkflowIssue,
  WorkflowIssueGroup,
} from '../../model/validation/issues';
import {
  findWorkflowStep,
  type WorkflowValidationTarget,
} from '../../model/validation/target';

/** Findings grouped under the step they belong to, each with a Fix. */
export function IssuesList({
  groups,
  graph,
  onFix,
  fixableGraph = graph,
}: Readonly<{
  groups: readonly WorkflowIssueGroup[];
  graph: WorkflowGraphContract;
  onFix?: (target: WorkflowValidationTarget) => void;
  fixableGraph?: WorkflowGraphContract;
}>) {
  const describeStep = useStepDescriptions();
  return (
    <ul className="flex flex-col gap-3" aria-label="Issues by step">
      {groups.map((group) => {
        const node =
          group.nodeId === null
            ? undefined
            : findWorkflowStep(graph, group.nodeId);
        const step =
          node === undefined ? undefined : describeStep(node.definition);
        const name =
          node === undefined ? 'Whole workflow' : (node.label ?? step?.name);
        const canFix =
          group.nodeId !== null &&
          findWorkflowStep(fixableGraph, group.nodeId) !== undefined;
        return (
          <li
            key={group.nodeId ?? 'workflow'}
            className="flex flex-col gap-1.5"
          >
            <p className="flex items-center gap-2 text-label font-semibold">
              {step === undefined ? null : <StepTile step={step} size="sm" />}
              <span className="truncate">{name}</span>
            </p>
            <ul className="flex flex-col gap-1 pl-1">
              {group.issues.map((issue) => {
                const message = labelIssue(issue, node, step?.configSchema);
                const target = issue.target;
                return (
                  <li
                    key={issue.id}
                    className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2 text-label leading-snug"
                  >
                    <StatusMark
                      display="mark"
                      tone="failure"
                      className="mt-px text-destructive"
                    />
                    <span className="text-muted-foreground">{message}</span>
                    {target === undefined ||
                    !canFix ||
                    onFix === undefined ? null : (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label={`Fix: ${message}`}
                        onClick={() => {
                          onFix(target);
                        }}
                      >
                        <WrenchIcon data-icon="inline-start" />
                        Fix
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function labelIssue(
  { message, target }: WorkflowIssue,
  node: WorkflowGraphContract['nodes'][number] | undefined,
  configSchema: unknown,
): string {
  const key = target?.fieldKey;
  if (
    key === undefined ||
    !message.toLowerCase().startsWith(`${key.toLowerCase()} `)
  )
    return message;
  const union = readSchemaUnion(configSchema);
  const choice = union === undefined ? undefined : node?.config[union.key];
  const schema =
    typeof choice === 'string'
      ? (union?.variants.get(choice) ?? configSchema)
      : configSchema;
  const field = schemaFields(schema, { jsonObjects: true }).find(
    (field) => (field.parent?.key ?? field.key) === key,
  );
  const label =
    field?.parent?.label ??
    field?.label ??
    (union?.key === key ? union.title : undefined) ??
    fieldLabel(key);
  return label + message.slice(key.length);
}
