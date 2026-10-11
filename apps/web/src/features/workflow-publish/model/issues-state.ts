import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { WorkflowPublication } from '../data/mutations/use-workflow-publication';
import {
  groupWorkflowIssues,
  groupWorkflowFindings,
  issueCountsByNode,
  type WorkflowIssue,
  type WorkflowIssueGroup,
} from './workflow-issues';

export type IssuesState = Readonly<{
  checking: boolean;
  error: string | undefined;
  groups: readonly WorkflowIssueGroup[] | undefined;
  /** The report describes an earlier draft than the one on screen. */
  stale: boolean;
}>;

export type WorkflowIssuesView = IssuesState &
  Readonly<{
    countsByNode: ReadonlyMap<string, number>;
    /** Only fresh server validation governs whether publishing is blocked. */
    blockingGroups: readonly WorkflowIssueGroup[];
  }>;

const noCounts: ReadonlyMap<string, number> = new Map();

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
  const groups =
    validationGroups === undefined && connectionIssues.length === 0
      ? undefined
      : groupWorkflowFindings([
          ...(validationGroups ?? []).flatMap((group) => group.issues),
          ...connectionIssues,
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
    countsByNode: groups === undefined ? noCounts : issueCountsByNode(groups),
  };
}
