// Node only: graph checksums use node:crypto, and expressions and authoring
// validation run in worker threads. Everything else is in ./index.ts.
export {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
  type WorkflowAuthoringValidationOptions,
} from './authoring-validation/contracts.js';
export { WorkflowAuthoringValidator } from './authoring-validation/validator.js';
export { JsonataEvaluator } from './expressions/evaluator.js';
export type { ExpressionEvaluator } from './expressions/policy.js';
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
} from './expressions/variable-usage.js';

export { resolveEventCoordinationKey } from './event-coordination/key.js';

export { inspectExpression } from './expressions/policy.js';
export type { CallbackReference } from './callbacks/references.js';

export {
  callbackReferenceIssue,
  hasCallbackMapping,
} from './callbacks/validation.js';
