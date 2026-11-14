// Node only: graph checksums use node:crypto, and expressions and authoring
// validation run in worker threads. Everything else is in ./index.ts.

// Graphs
export {
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
  workflowDefinitionCatalogFingerprint,
  type WorkflowDefinitionCatalog,
} from './graph/definition-catalog.js';
export { workflowDraftRepresentationTag } from './graph/draft-representation.js';
export { workflowIntegrationUsage } from './graph/integration-usage.js';
export { parseWorkflowGraphForPublish } from './graph/publish-workflow-graph.js';

// Flow control
export {
  callbackReferenceIssue,
  hasCallbackMapping,
} from './flow/callbacks/callback-references.validation.js';
export type { CallbackReference } from './flow/callbacks/references.js';

// Triggers
export { resolveEventCoordinationKey } from './triggers/event-coordination/key.js';

// Values
export { JsonataEvaluator } from './values/expressions/evaluator.js';
export {
  EXPRESSION_POLICY,
  type ExpressionEvaluator,
  type ExpressionLimit,
  type ExpressionResult,
} from './values/expressions/expression-policy.js';
export {
  inspectExpression,
  isTemporaryExpressionFailure,
} from './values/expressions/expression-policy.js';
export {
  workflowVariableSources,
  inspectWorkflowVariableSource,
  type WorkflowVariableReference,
  type WorkflowVariableSource,
} from './values/expressions/variable-usage.js';

// Authoring
export {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
  type WorkflowAuthoringValidationOptions,
} from './authoring/validation/validation-protocol.js';
export { WorkflowAuthoringValidator } from './authoring/validation/validator.js';
