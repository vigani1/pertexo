import { describeValidationIssue } from '@/lib/workflows/validation-message';
import type {
  WorkflowGraphContract,
  WorkflowValidateResponse,
} from '@pertexo/contracts';
import {
  resolveWorkflowCompatibilityTarget,
  resolveWorkflowValidationTarget,
  type WorkflowValidationTarget,
} from './target';

export type WorkflowIssue = Readonly<{
  id: string;
  message: string;
  target: WorkflowValidationTarget | undefined;
}>;

export type WorkflowIssueGroup = Readonly<{
  /** Null for issues about the workflow as a whole. */
  nodeId: string | null;
  issues: readonly WorkflowIssue[];
}>;

/** Every finding of a report in human words, grouped by the step it names. */
export function groupWorkflowIssues(
  report: WorkflowValidateResponse,
  graph: WorkflowGraphContract,
  source: 'validation' | 'publication' = 'validation',
): readonly WorkflowIssueGroup[] {
  const issues: WorkflowIssue[] = [
    ...report.issues.map((issue, index) => ({
      id: `issue-${String(index)}`,
      message:
        source === 'publication'
          ? issue.message
          : describeValidationIssue(issue),
      target: resolveWorkflowValidationTarget(issue, graph),
    })),
    ...report.compatibility.issues.map((issue, index) => ({
      id: `compatibility-${String(index)}`,
      message:
        'This step’s type isn’t in the catalog any more. Replace it with an available step.',
      target: resolveWorkflowCompatibilityTarget(issue, graph),
    })),
  ];
  return groupWorkflowFindings(issues);
}

/** Findings from server validation and current credential readiness share a step. */
export function groupWorkflowFindings(
  issues: readonly WorkflowIssue[],
): readonly WorkflowIssueGroup[] {
  const groups = new Map<string | null, WorkflowIssue[]>();
  for (const issue of issues) {
    const key = issue.target?.nodeId ?? null;
    const group = groups.get(key) ?? [];
    group.push(issue);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([nodeId, grouped]) => ({ nodeId, issues: grouped }))
    .sort((left, right) => {
      if (left.nodeId === null) {
        return 1;
      }
      if (right.nodeId === null) {
        return -1;
      }
      return 0;
    });
}

export function issueCountsByNode(
  groups: readonly WorkflowIssueGroup[],
): ReadonlyMap<string, number> {
  return new Map(
    groups.flatMap((group) =>
      group.nodeId === null ? [] : [[group.nodeId, group.issues.length]],
    ),
  );
}

export function countIssues(groups: readonly WorkflowIssueGroup[]): number {
  return groups.reduce((total, group) => total + group.issues.length, 0);
}
