// Node only: graph checksums use node:crypto, and expressions and authoring
// validation run in worker threads. Everything else is in ./index.ts.
export {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
  type WorkflowAuthoringValidationOptions,
} from './authoring/validation/contracts.js';
export { WorkflowAuthoringValidator } from './authoring/validation/validator.js';
export { JsonataEvaluator } from './values/expressions/evaluator.js';
export type { ExpressionEvaluator } from './values/expressions/policy.js';
export {
  EMPTY_DEFINITION_CATALOG,
  parseWorkflowGraphForPublish,
  workflowCompatibilityReport,
  workflowDefinitionCatalogFingerprint,
  workflowDraftRepresentationTag,
  workflowIntegrationUsage,
  type WorkflowDefinitionCatalog,
} from './graph/identity.js';

export {
  workflowVariableSources,
  inspectWorkflowVariableSource,
  type WorkflowVariableReference,
  type WorkflowVariableSource,
} from './values/expressions/variable-usage.js';

export { resolveEventCoordinationKey } from './triggers/event-coordination/key.js';

export {
  inspectExpression,
  isTemporaryExpressionFailure,
} from './values/expressions/policy.js';
export type { CallbackReference } from './flow/callbacks/references.js';

export {
  callbackReferenceIssue,
  hasCallbackMapping,
} from './flow/callbacks/validation.js';
