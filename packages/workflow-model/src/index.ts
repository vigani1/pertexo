// Safe anywhere, including the browser. Node-only parts are in ./server.ts.
export {
  WORKFLOW_TRIGGER_DEFINITIONS,
  type WorkflowTriggerDefinition,
  isWorkflowTriggerKey,
  isWorkflowTriggerDefinition,
} from './graph/triggers.js';
export { assertNever } from './assert-never.js';
export {
  WORKFLOW_FAILURE_PORT,
  WORKFLOW_FAILURE_FIELDS,
  WORKFLOW_FAILURE_PATHS,
  isWorkflowFailureSource,
  type WorkflowFailureRoute,
} from './flow/failure-routing/contract.js';
export {
  inspectWorkflowFailureRoutes,
  type FailureRoutingGraph,
  type WorkflowFailureRoutes,
} from './flow/failure-routing/validation.js';
export {
  isRoutableExecutorFailure,
  workflowNodeFailureValueSchema,
  workflowFailureClassificationSchema,
  type WorkflowNodeFailureValue,
} from './flow/failure-routing/value.js';
export {
  inspectWorkflowDecisionTree,
  type WorkflowDecisionTree,
} from './flow/failure-routing/decision-tree.js';
export {
  WORKFLOW_RECOVERY_LIMITS,
  WORKFLOW_RECOVERY_REFUSALS,
  type WorkflowRecoveryEffectRisk,
  type WorkflowRecoveryRefusal,
} from './execution/recovery/contract.js';
export {
  workflowCallPinSchema,
  workflowCallConfigSchema,
  isWorkflowCallDefinition,
  type WorkflowCallConfig,
} from './flow/callable/invocation.js';
export type { WorkflowCallPin } from './flow/callable/dependencies.js';
export { CallableInputInvalidError } from './flow/callable/errors.js';
export {
  callableTypeStructuralSchema,
  callableTypeIssues,
  type CallableType,
  type CallableDeclaration,
  type CallableTypeIssue,
} from './flow/callable/contract.js';
export {
  validateCallableValue,
  type CallableValueIssue,
} from './flow/callable/validate-value.js';
export {
  SAFE_EXECUTOR_ERROR_CODE_PATTERN,
  isSafeExecutorErrorCode,
} from './execution/attempt-failure.js';
export {
  FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES,
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationContextSchema,
  FailureNotificationDeliveryResultSchema,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationContext,
  type FailureNotificationDeliveryResult,
  type FailureNotificationDestinationConfig,
} from './execution/failure-notification.js';
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
  type GraphValidationIssue,
} from './graph/validation/contract.js';
export {
  CANONICAL_JSON_MAX_DEPTH,
  canonicalJson,
  canonicalizeJson,
  normalizedJson,
  normalizeJson,
  inspectJsonValue,
  type JsonValue,
} from './values/json/canonical.js';
export { parseJsonPath, resolveJsonPath } from './values/json/path.js';
export {
  DEFAULT_STEP_RETRY_SETTINGS,
  STEP_RETRY_LIMITS,
  stepRetrySettingsSchema,
  supportsStepRetrySettings,
  type StepRetrySettings,
} from './execution/step-retries/contract.js';
export {
  planWorkflowLifecycleCommand,
  workflowActivationAfterReconciliation,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
  workflowTriggerStatusSchema,
  type WorkflowActivationStatus,
  type WorkflowLifecycleStatus,
  type WorkflowTriggerStatus,
} from './execution/lifecycle.js';
export {
  resolveValueSource,
  type ValueResolution,
} from './values/mapping/resolve.js';
export { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from './execution/observation-window.js';
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
} from './authoring/portability/contract.js';
export {
  WorkflowPortabilityError,
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from './authoring/portability/projection.js';

export { compareOrdinal } from './values/ordering.js';

export { isRecord } from './values/json/object.js';
export { UUID_PATTERN } from './values/identifiers.js';

export {
  summarizeWorkflowCalls,
  validateCallDependencyClosure,
  WorkflowCallDependencyError,
  type CallableVersionSummary,
} from './flow/callable/dependencies.js';

export {
  workflowErrorInputSchema,
  type WorkflowErrorInput,
} from './triggers/error-workflows/contract.js';

export { isWorkflowErrorTarget } from './triggers/error-workflows/target.js';

export {
  approvalConfigSchema,
  approvalDecisionSchema,
  approvalOutputSchema,
  isHumanTaskDefinition,
  type ApprovalConfig,
  type ApprovalOutput,
} from './flow/pending-tasks/approval.js';

export {
  PENDING_TASK_LIMITS,
  taskAudienceSchema,
  type TaskAudience,
} from './flow/pending-tasks/audience.js';
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
  parseFormValues,
  formSubmissionSchema,
  formValuesSchema,
  FormValuesInvalidError,
  formFileUploads,
  attachFormFiles,
  type FormValues,
  type FormSubmission,
} from './triggers/forms/values.js';
export {
  FORM_FILE_LIMITS,
  FORM_FILE_GROUPS,
  formFileGroupSchema,
  formFileValueSchema,
  FormFileRejectedError,
  formFileType,
  formFileExtension,
  formFilename,
  assertFormFileSize,
  formFileMatchesType,
  describeFormFileGroups,
  formatFormFileBytes,
  type FormFileExtension,
  type FormFileGroup,
  type FormFileRejection,
  type FormFileValue,
} from './triggers/forms/files.js';
export {
  inputRequestConfigSchema,
  type InputRequestConfig,
} from './flow/pending-tasks/input-request.js';

export {
  WORKSPACE_VARIABLE_LIMITS,
  workspaceVariableNameSchema,
  workspaceVariableValueSchema,
  workspaceVariableValuesSchema,
  workspaceVariableSnapshotSchema,
  workspaceVariableDescriptionsSchema,
  EMPTY_VARIABLE_SNAPSHOT,
  type WorkspaceVariableValues,
  type WorkspaceVariableSnapshot,
} from './values/variables/contract.js';

export { ianaTimeZoneSchema } from './values/json/time-zone.js';
export {
  taskDetailsSchema,
  taskContextSchema,
  parseTaskPrefill,
  type TaskContext,
} from './flow/pending-tasks/context.js';

export {
  formRedirectUrlSchema,
  formLinkUrlSchema,
} from './triggers/forms/links.js';

export {
  stepSampleIdentity,
  stepSampleBindings,
} from './authoring/samples/identity.js';
export type { StepSampleSource } from './authoring/samples/contract.js';

export { isStorageText } from './values/json/text.js';
export {
  workflowTestExpectationsSchema,
  testAssertionSchema,
  testExpectationValueSchema,
  DEFAULT_TEST_EXPECTATIONS,
  type WorkflowTestExpectations,
  type TestAssertion,
} from './authoring/test-suites/contract.js';
export {
  matchesTestAssertion,
  observeTestAssertion,
  type TestAssertionObservation,
} from './authoring/test-suites/compare.js';

export { workflowTestStepChoices } from './authoring/test-suites/steps.js';

export {
  EVENT_COORDINATION_LIMITS,
  eventCoordinationKeySchema,
  eventCoordinationPolicySchema,
  eventCoordinationReceiptSchema,
  eventCoordinationOutcomeSchema,
  eventCoordinationStatusSchema,
  eventCoordinationReasonSchema,
  isEventCoordinationTrigger,
  type EventCoordinationPolicy,
  type EventCoordinationReceipt,
  type EventCoordinationStatus,
  type EventCoordinationReason,
} from './triggers/event-coordination/contract.js';
export {
  decideEventCoordination,
  type EventCoordinationWindow,
} from './triggers/event-coordination/decision.js';

export { workflowNodes } from './graph/nodes.js';

export { collectionPathSchema } from './values/json/path-validation.js';

export {
  WORKFLOW_NOTE_LIMITS,
  workflowNoteColorSchema,
  workflowNoteSchema,
  workflowNotesSchema,
  type WorkflowNote,
  type WorkflowNoteColor,
} from './graph/notes/contract.js';
export { sameWorkflowNotes } from './graph/notes/identity.js';

export {
  webhookAuthenticationSchema,
  type WebhookAuthentication,
} from './triggers/webhooks/authentication.js';

export {
  callbackWaitConfigSchema,
  waitConfigSchema,
  WAIT_MAXIMUM_SECONDS,
  isCallbackWaitNode,
  isPendingTaskNode,
  type CallbackWaitConfig,
  type CallbackBindings,
  type CallbackBinding,
} from './flow/callbacks/contract.js';

export { supportsExpressionMappings } from './values/mapping/policy.js';

export {
  callbackTargetNodes,
  callbackMappingExpression,
} from './flow/callbacks/validation.js';

export { remapCallbackReferences } from './flow/callbacks/references.js';

export { cronHasUnsupportedOperators } from './triggers/schedules/cron.js';

export * from './workspaces/policy.js';
export {
  utf8ByteLength,
  isWellFormed,
  jsonStringByteLength,
} from './values/text.js';

export {
  PROMOTION_LIMITS,
  COLLABORATION_LIMITS,
} from './workspaces/authoring-limits.js';

export { AUDIT_RETENTION_MIN_DAYS } from './workspaces/governance.js';

export {
  FEDERATION_LIMITS,
  ACCOUNT_SIGN_IN_METHOD_LIMIT,
  API_TOKEN_SCOPES,
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_ACTIVE_LIMIT,
  apiTokenCredentialSchema,
} from './workspaces/identity-policy.js';

export { CORE_WEBHOOK_CONFIG_SCHEMA } from './triggers/webhook.js';
export {
  DIRECTORY_LIMITS,
  AUTHENTICATION_PROVIDERS,
} from './workspaces/identity-policy.js';

export {
  workflowTemplateOriginRequestSchema,
  workflowTemplateOriginSchema,
  type WorkflowTemplateOriginRequest,
  type WorkflowTemplateOrigin,
} from './authoring/portability/origin.js';

export { publishesSlackBinding } from './execution/dispatch-binding.js';

export {
  requiresFormAdmissionCheck,
  formAdmissionRequirement,
  capturedFormReplayMatches,
} from './triggers/forms/admission.js';

export { parseIdentityMetadata } from './workspaces/identity-metadata.js';

export {
  addedWorkflowCallTargets,
  addedWorkflowConnectionReferences,
  workflowConnectionReferences,
  connectionReferenceIds,
} from './authoring/bindings.js';

export { decideInvitationAcceptance } from './workspaces/invitation-acceptance.js';

export { publicationReviewDecision } from './authoring/reviews/decision.js';
export { requiresPublicationReviewer } from './workspaces/governance.js';
export { planWorkspaceVariableReplacement } from './values/variables/replacement.js';

export {
  workflowTestSuiteReportSchema,
  type SuiteCaseReport,
} from './authoring/test-suites/report.js';

export {
  failureNotificationCompletionDecision,
  failureNotificationCompletionAuditFactType,
} from './execution/notification-completion.js';

export {
  notificationProviderRequirements,
  eligibleNotificationDestination,
  eligibleNotificationConnection,
} from './execution/notification-policy.js';
export { decideScheduleHealthTransition } from './triggers/schedules/health.js';

export * from './authoring/connections/contract.js';
export {
  classifyConnectionTestCompletion,
  connectionTestStatus,
} from './authoring/connections/health.js';
export {
  noticeScheduleSchema,
  noticeEmailModeSchema,
  nextNoticeDue,
  noticeWindow,
  nextPersonNoticeDue,
  type NoticeSchedule,
} from './execution/notice-schedule.js';
