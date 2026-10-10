// Safe anywhere, including the browser. Node-only parts are in ./server.ts.
export { assertNever } from './assert-never.js';
export {
  callableTypeStructuralSchema,
  callableTypeIssues,
  type CallableType,
  type CallableTypeIssue,
} from './callable/contract.js';
export {
  validateCallableValue,
  type CallableValueIssue,
} from './callable/validate-value.js';
export {
  SAFE_EXECUTOR_ERROR_CODE_PATTERN,
  isSafeExecutorErrorCode,
} from './attempt-failure.js';
export {
  FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES,
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationContextSchema,
  FailureNotificationDeliveryResultSchema,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationContext,
  type FailureNotificationDeliveryResult,
  type FailureNotificationDestinationConfig,
} from './failure-notification.js';
export {
  EMPTY_WORKFLOW_GRAPH,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_VALIDATION_MAX_ISSUES,
  workflowGraphSchema,
  workflowGraphStructuralSchema,
  type ForEachStructure,
  type StructuredBody,
  type ValueSource,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSettings,
} from './graph/contract.js';
export {
  workflowControlOutputKind,
  workflowControlOutputNodeIds,
} from './graph/control-output-selection.js';
export {
  workflowDefinitionPlacementIssues,
  type WorkflowDefinitionPlacementIssue,
} from './graph/definition-placement.js';
export {
  parseWorkflowGraphDraft,
  safeParseWorkflowGraphDraft,
} from './graph/validation/preflight.js';
export { validateWorkflowGraph } from './graph/validation/index.js';
export {
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
  type GraphValidationResult,
} from './graph/validation/contract.js';
export {
  CANONICAL_JSON_MAX_DEPTH,
  canonicalJson,
  canonicalizeJson,
  inspectJsonValue,
  type JsonValue,
} from './json/canonical.js';
export { parseJsonPath, resolveJsonPath } from './json/path.js';
export {
  planWorkflowLifecycleCommand,
  workflowActivationAfterReconciliation,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
  workflowTriggerStatusSchema,
  type WorkflowActivationStatus,
  type WorkflowLifecycleStatus,
  type WorkflowTriggerStatus,
} from './lifecycle.js';
export { resolveValueSource, type ValueResolution } from './mapping.js';
export { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from './observation-window.js';
export {
  PortableJsonError,
  WORKFLOW_PORTABILITY_LIMITS,
  canonicalWorkflowPortableJson,
  parsePortableJson,
  portableConnectionBindingSchema,
  portableConnectionSlotSchema,
  portableGraphDigest,
  portableIssueSchema,
  portableManifestDigest,
  workflowPortableManifestSchema,
  workflowPortableManifestStructuralSchema,
  type PortableConnectionBinding,
  type PortableConnectionSlot,
  type PortableIssue,
  type WorkflowPortableManifest,
} from './portability/contract.js';
export {
  WorkflowPortabilityError,
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from './portability/projection.js';

export { compareOrdinal } from './ordering.js';

export { isRecord } from './json/object.js';
export { UUID_PATTERN } from './identifiers.js';
