import { canonicalJson } from '../../json/canonical.js';
import type { WorkflowNote } from './contract.js';

type DocumentedGraph = Readonly<{
  notes?: readonly WorkflowNote[] | undefined;
}>;

/** Documentation participates in publication reuse, never execution identity. */
export function sameWorkflowNotes(
  before: DocumentedGraph,
  after: DocumentedGraph,
): boolean {
  return canonicalJson(before.notes ?? []) === canonicalJson(after.notes ?? []);
}
