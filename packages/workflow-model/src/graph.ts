import './server-only.js';

import {
  workflowSettingsSchemaV1,
  type WorkflowGraph,
} from './graph-contract.js';

export {
  InvalidInvocationScopeError,
  invocationIdentity,
  type InvocationIdentityInput,
  type InvocationScopePart,
} from './invocation-identity.js';

export type {
  ForEachStructure,
  NodeId,
  StructuredBody,
  ValueSource,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowSettings,
} from './graph-contract.js';
export { WORKFLOW_EXECUTION_LIMITS_V1 } from './graph-contract.js';

export {
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
  type GraphIssueCode,
  type GraphValidationIssue,
  type GraphValidationResult,
  type WorkflowGraphContractIssueCode,
  type WorkflowGraphLimits,
} from './graph/validation-contract.js';
export {
  parseWorkflowGraphDraft,
  safeParseWorkflowGraphDraft,
  type WorkflowGraphDraftParseResult,
} from './graph/preflight.js';
export { validateWorkflowGraph } from './graph/validation.js';
export {
  EMPTY_DEFINITION_CATALOG_FINGERPRINT_V1,
  EMPTY_DEFINITION_CATALOG_V1,
  parseRetainedWorkflowVersionV1,
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowExecutableChecksum,
  workflowExecutableProjection,
  workflowIntegrationUsage,
  workflowRetainedExecutableChecksum,
  type RetainedWorkflowVersionV1,
  type WorkflowCompatibilityIssue,
  type WorkflowCompatibilityReport,
  type WorkflowDefinitionCatalogV1,
  type WorkflowDraftRepresentationTag,
  type WorkflowIntegrationUsage,
} from './graph/identity.js';

export const EMPTY_WORKFLOW_GRAPH_V1: WorkflowGraph = Object.freeze({
  schemaVersion: 1,
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
  settings: Object.freeze({}),
});
export const WorkflowSettingsSchemaV1 = workflowSettingsSchemaV1;
