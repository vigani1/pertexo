// Safe anywhere, including the browser. Node-only parts are in ./server.ts.

// Graphs
export {
  workflowControlOutputKind,
  workflowControlOutputNodeIds,
} from './graph/control-output-selection.js';
export {
  workflowDefinitionPlacementIssues,
  type WorkflowDefinitionPlacementIssue,
} from './graph/definition-placement.js';
export { workflowExecutableChecksumSchema } from './graph/executable-checksum.js';
export {
  workflowExecutionValues,
  valueSourceExecutionIdentity,
} from './graph/execution-values.js';
export { workflowNodes } from './graph/nodes.js';
export {
  WORKFLOW_NOTE_LIMITS,
  workflowNoteColorSchema,
  type WorkflowNote,
} from './graph/notes/canvas-note.schemas.js';
export { sameWorkflowNotes } from './graph/notes/identity.js';
export {
  WORKFLOW_TRIGGER_DEFINITIONS,
  isWorkflowTriggerKey,
  isWorkflowTriggerDefinition,
} from './graph/triggers.js';
export {
  WORKFLOW_GRAPH_LIMITS,
  type GraphValidationResult,
  type GraphValidationIssue,
} from './graph/validation/graph-validation.js';
export {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from './graph/validation/graph-validation.errors.js';
export {
  parseWorkflowGraphDraft,
  safeParseWorkflowGraphDraft,
} from './graph/validation/preflight.js';
export { validateWorkflowGraph } from './graph/validation/validate-workflow-graph.js';
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
  type WorkflowSettings,
  type WorkflowNode,
} from './graph/workflow-graph.schemas.js';

// Flow control
export { CallableInputInvalidError } from './flow/callable/callable.errors.js';
export {
  type CallableType,
  type CallableDeclaration,
} from './flow/callable/callable-types.js';
export type { WorkflowCallPin } from './flow/callable/dependencies.js';
export {
  summarizeWorkflowCalls,
  validateCallDependencyClosure,
  type CallableVersionSummary,
} from './flow/callable/dependencies.js';
export { WorkflowCallDependencyError } from './flow/callable/callable.errors.js';
export {
  workflowCallConfigSchema,
  isWorkflowCallDefinition,
  type WorkflowCallConfig,
} from './flow/callable/invocation.js';
export { validateCallableValue } from './flow/callable/validate-value.js';
export {
  callbackTargetNodes,
  callbackMappingExpression,
} from './flow/callbacks/callback-references.validation.js';
export {
  callbackWaitConfigSchema,
  waitConfigSchema,
  WAIT_MAXIMUM_SECONDS,
  isCallbackWaitNode,
  isPendingTaskNode,
  type CallbackWaitConfig,
  type CallbackBindings,
} from './flow/callbacks/callback-wait.js';
export { remapCallbackReferences } from './flow/callbacks/references.js';
export {
  inspectControlNodeConfig,
  type ControlNodeConfig,
} from './flow/control-nodes/config.js';
export {
  mergeConfigSchema,
  type MergeConfig,
} from './flow/control-nodes/merge.js';
export {
  PARALLEL_BRANCH_PORTS,
  parallelBranchPortSchema,
  parallelConfigSchema,
  type ParallelConfig,
} from './flow/control-nodes/parallel.js';
export {
  SWITCH_CASE_PORTS,
  switchConfigSchema,
  switchScalarSchema,
  type SwitchConfig,
} from './flow/control-nodes/switch.js';
export { inspectWorkflowDecisionTree } from './flow/failure-routing/decision-tree.js';
export {
  WORKFLOW_FAILURE_PORT,
  WORKFLOW_FAILURE_FIELDS,
  WORKFLOW_FAILURE_PATHS,
  isWorkflowFailureSource,
  type WorkflowFailureRoute,
} from './flow/failure-routing/failure-routes.js';
export { inspectWorkflowFailureRoutes } from './flow/failure-routing/failure-routes.validation.js';
export {
  isRoutableExecutorFailure,
  workflowNodeFailureValueSchema,
  workflowFailureClassificationSchema,
  type WorkflowNodeFailureValue,
} from './flow/failure-routing/value.js';
export {
  approvalConfigSchema,
  approvalDecisionSchema,
  approvalOutputSchema,
  isHumanTaskDefinition,
  taskExpiryChoice,
  taskExpiryChoiceSchema,
  type TaskExpiryChoice,
  type ApprovalConfig,
} from './flow/pending-tasks/approval.js';
export {
  PENDING_TASK_LIMITS,
  taskAudienceSchema,
  type TaskAudience,
} from './flow/pending-tasks/audience.js';
export {
  taskDetailsSchema,
  taskContextSchema,
  parseTaskPrefill,
  type TaskContext,
} from './flow/pending-tasks/context.js';
export {
  inputRequestConfigSchema,
  type InputRequestConfig,
} from './flow/pending-tasks/input-request.js';
export {
  TIMED_OUT_PORT,
  continuesOnExpiry,
  pendingTaskOutputPorts,
  timedOutTaskOutput,
  timedOutTaskOutputSchema,
} from './flow/pending-tasks/timeout.js';

// Execution
export { isSafeExecutorErrorCode } from './execution/attempt-failure.js';
export {
  DATA_RETENTION_DAYS,
  WEBHOOK_TEST_CAPTURE_SECONDS,
} from './execution/data-retention.js';
export {
  planWorkflowLifecycleCommand,
  workflowActivationAfterReconciliation,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
  type WorkflowActivationStatus,
  type WorkflowLifecycleStatus,
  type WorkflowTriggerStatus,
} from './execution/lifecycle.js';
export {
  noticeScheduleSchema,
  noticeEmailModeSchema,
  nextNoticeDue,
  noticeWindow,
  nextPersonNoticeDue,
  type NoticeSchedule,
} from './execution/notice-schedule.js';
export { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from './execution/observation-window.js';
export {
  RUN_FAILURE_CODES,
  runFailureCodeSchema,
  type RunFailureCode,
  type CallableResultFailureCode,
} from './execution/run-failure.js';
export {
  RUN_STATUS,
  RUN_STATUSES,
  type RunStatus,
} from './execution/run-status.js';
export {
  DEFAULT_STEP_RETRY_SETTINGS,
  STEP_RETRY_LIMITS,
  supportsStepRetrySettings,
  type StepRetrySettings,
} from './execution/step-retry.schemas.js';
export {
  WORKFLOW_RECOVERY_LIMITS,
  WORKFLOW_RECOVERY_REFUSALS,
  type WorkflowRecoveryEffectRisk,
  type WorkflowRecoveryRefusal,
} from './execution/workflow-recovery.js';

// Triggers
export { isWorkflowErrorTarget } from './triggers/error-workflows/target.js';
export {
  workflowErrorInputSchema,
  type WorkflowErrorInput,
} from './triggers/error-workflows/workflow-error-input.schemas.js';
export {
  decideEventCoordination,
  type EventCoordinationWindow,
} from './triggers/event-coordination/decision.js';
export {
  EVENT_COORDINATION_LIMITS,
  eventCoordinationPolicySchema,
  eventCoordinationReceiptSchema,
  eventCoordinationStatusSchema,
  eventCoordinationReasonSchema,
  type EventCoordinationPolicy,
  type EventCoordinationReceipt,
  type EventCoordinationStatus,
  type EventCoordinationReason,
  asksSenderToRetry,
} from './triggers/event-coordination/event-coordination.schemas.js';
export {
  requiresFormAdmissionCheck,
  formAdmissionRequirement,
  capturedFormReplayMatches,
} from './triggers/forms/admission.js';
export {
  FORM_LIMITS,
  formFieldSchema,
  formFieldsSchema,
  formConfigSchema,
  formThankYouMessageSchema,
  DEFAULT_FORM_THANK_YOU_MESSAGE,
  type FormField,
  type FormConfig,
} from './triggers/forms/fields.js';
export {
  FORM_FILE_LIMITS,
  FORM_FILE_GROUPS,
  formFileValueSchema,
  formFileType,
  formFileExtension,
  formFilename,
  assertFormFileSize,
  formFileMatchesType,
  type FormFileGroup,
  type FormFileValue,
} from './triggers/forms/files.js';
export { FormFileRejectedError } from './triggers/forms/forms.errors.js';
export {
  formRedirectUrlSchema,
  formLinkUrlSchema,
} from './triggers/forms/links.js';
export {
  parseFormValues,
  formSubmissionSchema,
  formFileUploads,
  attachFormFiles,
  type FormValues,
} from './triggers/forms/values.js';
export { FormValuesInvalidError } from './triggers/forms/forms.errors.js';
export { cronHasUnsupportedOperators } from './triggers/schedule-cron.js';
export {
  webhookAuthenticationSchema,
  type WebhookAuthentication,
} from './triggers/webhook-authentication.js';
export { CORE_WEBHOOK_CONFIG_SCHEMA } from './triggers/webhook.js';

// Values
export { STORED_INTEGER_MAX } from './values/stored-integer.js';
export { UUID_PATTERN } from './values/identifiers.js';
export {
  CANONICAL_JSON_MAX_DEPTH,
  canonicalJson,
  canonicalizeJson,
  normalizedJson,
  normalizeJson,
  inspectJsonValue,
  type JsonValue,
} from './values/json/canonical.js';
export { isRecord } from './values/json/object.js';
export { collectionPathSchema } from './values/json/path-validation.js';
export { parseJsonPath, resolveJsonPath } from './values/json/path.js';
export { isStorageText, storageTextSchema } from './values/json/text.js';
export { supportsExpressionMappings } from './values/mapping/mapping-support.js';
export {
  resolveValueSource,
  type ValueResolution,
} from './values/mapping/resolve.js';
export { compareOrdinal } from './values/ordering.js';
export {
  utf8ByteLength,
  isWellFormed,
  jsonStringByteLength,
  withoutHiddenCharacters,
} from './values/text.js';
export { ianaTimeZoneSchema } from './values/time-zone.schemas.js';
export {
  WORKSPACE_VARIABLE_LIMITS,
  workspaceVariableNameSchema,
  workspaceVariableValuesSchema,
  workspaceVariableSnapshotSchema,
  workspaceVariableDescriptionsSchema,
  EMPTY_VARIABLE_SNAPSHOT,
  type WorkspaceVariableValues,
  type WorkspaceVariableSnapshot,
} from './values/variables/workspace-variable.schemas.js';

// Authoring
export {
  addedWorkflowCallTargets,
  addedWorkflowConnectionReferences,
  workflowConnectionReferences,
  connectionReferenceIds,
} from './authoring/bindings.js';
export * from './authoring/connection-vocabulary.js';
export {
  workflowTemplateOriginRequestSchema,
  workflowTemplateOriginSchema,
  type WorkflowTemplateOriginRequest,
  type WorkflowTemplateOrigin,
} from './authoring/portability/origin.js';
export {
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
} from './authoring/portability/portable-manifest.js';
export { PortableJsonError } from './authoring/portability/portability.errors.js';
export { WORKFLOW_PORTABILITY_LIMITS } from './authoring/portability/portability-limits.js';
export {
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from './authoring/portability/projection.js';
export { WorkflowPortabilityError } from './authoring/portability/portability.errors.js';
export { publicationReviewDecision } from './authoring/publication-review-decision.js';
export {
  stepSampleIdentity,
  stepSampleBindings,
} from './authoring/samples/identity.js';
export type { StepSampleSource } from './authoring/samples/step-sample-source.types.js';
export {
  observeTestAssertion,
  type TestAssertionObservation,
} from './authoring/test-suites/compare.js';
export {
  workflowTestSuiteReportSchema,
  type SuiteCaseReport,
} from './authoring/test-suites/report.js';
export { workflowTestStepChoices } from './authoring/test-suites/steps.js';
export {
  workflowTestExpectationsSchema,
  DEFAULT_TEST_EXPECTATIONS,
  type WorkflowTestExpectations,
} from './authoring/test-suites/workflow-test-expectations.schemas.js';

// Identity
export {
  AUTHENTICATION_PROVIDERS,
  FEDERATION_LIMITS,
  DIRECTORY_LIMITS,
  ACCOUNT_SIGN_IN_METHOD_LIMIT,
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_ACTIVE_LIMIT,
  apiTokenCredentialSchema,
} from './identity/identity-primitives.js';

// Failure notifications
export {
  FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES,
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationContextSchema,
  FailureNotificationDeliveryResultSchema,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationContext,
  type FailureNotificationDeliveryResult,
  type FailureNotificationDestinationConfig,
} from './notifications/failure-notification.schemas.js';

// Workspace authoring limits and governance
export {
  PROMOTION_LIMITS,
  COLLABORATION_LIMITS,
  CONNECTION_SHARE_LIMIT,
  FOLDER_GRANT_LIMIT,
} from './workspaces/authoring-limits.js';
export {
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
} from './workspaces/governance.js';
export { requiresPublicationReviewer } from './workspaces/governance.js';
