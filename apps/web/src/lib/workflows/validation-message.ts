import type { WorkflowValidateResponse } from '@pertexo/contracts';
type WorkflowValidationIssue = WorkflowValidateResponse['issues'][number];
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
