import { canonicalJson } from '../../values/json/canonical.js';
import type { WorkflowNote } from './canvas-note.schemas.js';

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
