import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';

export type DraftRepresentation = Readonly<{
  workflowId: string;
  revision: number;
  schemaVersion: number;
  graph: unknown;
  compatibilityFingerprint: string;
}>;

/**
 * Strong validator for the complete draft representation returned by HTTP.
 * The quoted value is intentionally opaque; clients must echo it verbatim.
 */
export function createDraftRepresentationTag(
  representation: DraftRepresentation,
): string {
  return workflowDraftRepresentationTag({
    workflowId: representation.workflowId,
    revision: representation.revision,
    graph: representation.graph,
    compatibilityFingerprint: representation.compatibilityFingerprint,
  });
}
