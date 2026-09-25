import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

export type EmptyDraftHint = Readonly<{
  /** Short enough for the issues chip and the Publish tooltip. */
  label: string;
  detail: string;
}>;

/**
 * What an empty draft needs before there's anything to check or publish.
 * This is only earlier feedback: once the draft has steps, the server's
 * validation decides whether it can be published.
 */
export function emptyDraftHint(
  graph: WorkflowGraphContract,
  triggersAvailable: boolean,
): EmptyDraftHint | undefined {
  if (graph.nodes.length > 0) return undefined;
  return triggersAvailable
    ? {
        label: 'Add a trigger to start',
        detail:
          'This draft has no steps yet, so there’s nothing to check or publish. Start with a trigger: it decides when the workflow runs.',
      }
    : {
        label: 'Add a step to start',
        detail:
          'This draft has no steps yet, so there’s nothing to check or publish. No triggers are enabled in this environment, so start with one of the available steps.',
      };
}
