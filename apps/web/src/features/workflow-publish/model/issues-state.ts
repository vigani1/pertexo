import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { WorkflowPublication } from '../mutations/use-workflow-publication';
import {
  groupWorkflowIssues,
  issueCountsByNode,
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
  Readonly<{ countsByNode: ReadonlyMap<string, number> }>;

const noCounts: ReadonlyMap<string, number> = new Map();

/** The latest report as the editor shows it: grouped, counted, and dated. */
export function workflowIssuesView(
  publication: Pick<
    WorkflowPublication,
    'validation' | 'validationPending' | 'validationError'
  >,
  graph: WorkflowGraphContract,
  draft: Readonly<{ generation: number; revision: number }>,
): WorkflowIssuesView {
  const { validation } = publication;
  const groups =
    validation === undefined
      ? undefined
      : groupWorkflowIssues(validation.report, graph);
  return {
    checking: publication.validationPending,
    error: publication.validationError,
    groups,
    stale:
      validation !== undefined &&
      (validation.generation !== draft.generation ||
        validation.revision !== draft.revision),
    countsByNode: groups === undefined ? noCounts : issueCountsByNode(groups),
  };
}
