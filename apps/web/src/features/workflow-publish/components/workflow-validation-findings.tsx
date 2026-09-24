import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { Button } from '@/components/ui/button';
import {
  resolveWorkflowCompatibilityTarget,
  resolveWorkflowValidationTarget,
  type WorkflowCompatibilityIssue,
  type WorkflowValidationIssue,
  type WorkflowValidationTarget,
} from '../model/validation-target';

export function WorkflowValidationFindings({
  structuralIssues,
  compatibilityIssues,
  graph,
  stale,
  onNavigate,
}: Readonly<{
  structuralIssues: readonly WorkflowValidationIssue[];
  compatibilityIssues: readonly WorkflowCompatibilityIssue[];
  graph: WorkflowGraphContract;
  stale: boolean;
  onNavigate: (target: WorkflowValidationTarget) => void;
}>) {
  const findingCount = structuralIssues.length + compatibilityIssues.length;
  if (findingCount === 0) return null;
  return (
    <section
      className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-left"
      aria-label="Workflow validation findings"
    >
      <p className="text-sm font-medium text-destructive">
        {String(findingCount)} validation{' '}
        {findingCount === 1 ? 'finding' : 'findings'}
        {stale ? ' from an earlier draft' : ''}
      </p>
      <ul className="mt-2 space-y-2">
        {structuralIssues.map((issue) => {
          const target = resolveWorkflowValidationTarget(issue, graph);
          return (
            <li
              key={`${issue.path}\u0000${issue.code}\u0000${issue.message}`}
              className="border-b border-white/8 py-2 last:border-b-0"
            >
              <p className="text-sm text-foreground">{issue.message}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {issue.code} · {issue.path}
              </p>
              {target === undefined ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-1 text-base sm:text-sm"
                  onClick={() => {
                    onNavigate(target);
                  }}
                >
                  {target.mappingKey !== undefined
                    ? `Go to ${target.mappingKey} input`
                    : target.fieldKey === undefined
                      ? 'Go to node'
                      : `Go to ${target.fieldKey}`}
                </Button>
              )}
            </li>
          );
        })}
        {compatibilityIssues.map((issue) => {
          const target = resolveWorkflowCompatibilityTarget(issue, graph);
          return (
            <li
              key={`${issue.code}\u0000${issue.definitionKey}\u0000${String(issue.version)}`}
              className="border-b border-white/8 py-2 last:border-b-0"
            >
              <p className="text-sm text-foreground">
                Definition {issue.definitionKey}@{String(issue.version)} is not
                available in the current catalog.
              </p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {issue.code} · {issue.definitionKey}@{String(issue.version)}
              </p>
              {target === undefined ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-1 text-base sm:text-sm"
                  onClick={() => {
                    onNavigate(target);
                  }}
                >
                  Go to matching node
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
