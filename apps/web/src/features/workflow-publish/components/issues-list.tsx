import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { WrenchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import type { WorkflowIssueGroup } from '../model/workflow-issues';
import type { WorkflowValidationTarget } from '../model/validation-target';

/** Findings grouped under the step they belong to, each with a Fix. */
export function IssuesList({
  groups,
  graph,
  onFix,
}: Readonly<{
  groups: readonly WorkflowIssueGroup[];
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Issues by step">
      {groups.map((group) => {
        const node =
          group.nodeId === null
            ? undefined
            : graph.nodes.find((candidate) => candidate.id === group.nodeId);
        const step =
          node === undefined ? undefined : describeStep(node.definition.key);
        const name =
          node === undefined ? 'Whole workflow' : (node.label ?? step?.name);
        return (
          <li
            key={group.nodeId ?? 'workflow'}
            className="flex flex-col gap-1.5"
          >
            <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
              {step === undefined ? null : <StepTile step={step} size="sm" />}
              <span className="truncate">{name}</span>
            </p>
            <ul className="flex flex-col gap-1 pl-1">
              {group.issues.map((issue) => (
                <li
                  key={issue.id}
                  className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2 text-[0.8rem] leading-snug"
                >
                  <StatusGlyph
                    tone="failure"
                    className="mt-px text-destructive"
                  />
                  <span className="text-muted-foreground">{issue.message}</span>
                  {issue.target === undefined ? null : (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={`Fix: ${issue.message}`}
                      onClick={() => {
                        if (issue.target !== undefined) onFix(issue.target);
                      }}
                    >
                      <WrenchIcon data-icon="inline-start" />
                      Fix
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
