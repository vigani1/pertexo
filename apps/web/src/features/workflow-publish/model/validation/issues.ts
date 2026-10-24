import type {
  WorkflowGraphContract,
  WorkflowValidateResponse,
} from '@pertexo/contracts';
import {
  resolveWorkflowCompatibilityTarget,
  resolveWorkflowValidationTarget,
  type WorkflowValidationIssue,
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
): readonly WorkflowIssueGroup[] {
  const issues: WorkflowIssue[] = [
    ...report.issues.map((issue, index) => ({
      id: `issue-${String(index)}`,
      message: describeValidationIssue(issue),
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

const messagesByCode: Readonly<Record<string, string>> = {
  invalid_mapping:
    'An input reads from a step that isn’t linked right before this one. Link that step here, or choose another source.',
  cycle:
    'These steps loop back on themselves. Remove one of the links in the loop.',
  dangling_edge:
    'A link crosses into or out of a For each body. Link steps inside the body instead.',
  duplicate_node_id: 'Two steps share the same ID. Delete one of them.',
  duplicate_edge_id: 'Two links share the same ID. Remove one of them.',
  invalid_loop_limit:
    'For each needs a positive item limit, and it can’t run more items at once than it allows in total.',
  loop_iteration_limit:
    'For each loops here could run too many times. Lower their item limits.',
  expansion_limit:
    'This workflow would run too many steps in one run. Lower loop limits or split the workflow.',
  graph_limit:
    'This workflow has too many steps or links. Split it into smaller workflows.',
  unknown_definition:
    'This step’s type isn’t in the catalog any more. Replace it with an available step.',
};

export function describeValidationIssue(
  issue: WorkflowValidationIssue,
): string {
  const known = messagesByCode[issue.code];
  if (known !== undefined) return known;
  const message = issue.message.trim();
  const sentence = `${message.charAt(0).toUpperCase()}${message.slice(1)}`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}
