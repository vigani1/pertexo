import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_GRAPH_JSON_VALUE_DEPTH,
} from '../../graph/workflow-graph.schemas.js';

export const WORKFLOW_PORTABILITY_LIMITS = Object.freeze({
  bytes: 2_097_152,
  inputDepth: 256,
  requirements: 1_000,
  connectionSlots: 1_000,
  issues: 100,
});

/**
 * Admission and field bounds inside a portable manifest. Depths are the
 * graph's own, so every workflow that publishes can be exported.
 */
export const PORTABLE_MANIFEST_FIELD_LIMITS = Object.freeze({
  jsonValueDepth: WORKFLOW_GRAPH_JSON_VALUE_DEPTH,
  structuredDepth: WORKFLOW_GRAPH_CONTRACT_LIMITS.structuredDepth,
  identifierLength: 1_048_576,
  keyLength: 128,
  issuePathLength: 2_048,
  issueMessageLength: 512,
});
