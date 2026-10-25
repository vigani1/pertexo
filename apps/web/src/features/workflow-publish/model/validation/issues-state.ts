import { unreachableStepIssues } from './reachability';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { WorkflowPublication } from '../../data/mutations/use-workflow-publication';
import {
  groupWorkflowIssues,
  groupWorkflowFindings,
  issueCountsByNode,
  type WorkflowIssue,
  type WorkflowIssueGroup,
} from './issues';

export type IssuesState = Readonly<{
  checking: boolean;
  error: string | undefined;
  groups: readonly WorkflowIssueGroup[] | undefined;
  /** The report describes an earlier draft than the one on screen. */
  stale: boolean;
}>;

export type WorkflowIssuesView = IssuesState &
  Readonly<{
    /** Unreachable steps are muted instead of wearing blocking-error badges. */
    countsByNode: ReadonlyMap<string, number>;
    /** Only fresh server validation governs whether publishing is blocked. */
    blockingGroups: readonly WorkflowIssueGroup[];
  }>;

/** The latest report as the editor shows it: grouped, counted, and dated. */
export function workflowIssuesView(
  publication: Pick<
    WorkflowPublication,
    'validation' | 'validationPending' | 'validationError'
  >,
  graph: WorkflowGraphContract,
  draft: Readonly<{ generation: number; revision: number }>,
  connectionIssues: readonly WorkflowIssue[] = [],
): WorkflowIssuesView {
  const { validation } = publication;
  const validationGroups =
    validation === undefined
      ? undefined
      : groupWorkflowIssues(validation.report, graph);
  const warnings = [...connectionIssues, ...unreachableStepIssues(graph)];
  const groups =
    validationGroups === undefined && warnings.length === 0
      ? undefined
      : groupWorkflowFindings([
          ...(validationGroups ?? []).flatMap((group) => group.issues),
          ...warnings,
        ]);
  const stale =
    validation !== undefined &&
    (validation.etag !== validation.requestedEtag ||
      validation.generation !== draft.generation ||
      validation.revision !== draft.revision);
  return {
    checking: publication.validationPending,
    error: publication.validationError,
    groups,
    stale,
    blockingGroups: stale ? [] : (validationGroups ?? []),
    countsByNode: issueCountsByNode(
      groupWorkflowFindings([
        ...(validationGroups ?? []).flatMap((group) => group.issues),
        ...connectionIssues,
      ]),
    ),
  };
}
