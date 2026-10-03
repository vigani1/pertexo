import {
  parseWorkflowAuthoringGraphDraft,
  workflowCallableDraftRepresentationTagV2,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/graph';

export type DraftRepresentation = Readonly<{
  workflowId: string;
  revision: number;
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
  const graph = parseWorkflowAuthoringGraphDraft(representation.graph);
  const tag =
    graph.schemaVersion === 2
      ? workflowCallableDraftRepresentationTagV2
      : workflowDraftRepresentationTag;
  return tag({
    workflowId: representation.workflowId,
    revision: representation.revision,
    graph,
    compatibilityFingerprint: representation.compatibilityFingerprint,
  });
}
