import { scenario } from '../fixture/environment.js';
import type { EditorBrowserJourneyContext } from '../fixture/contract.js';
import {
  verifyEditorOrganizationOidcOutcome,
  verifyEditorTwoFactorOutcome,
  verifyEditorFederationOutcome,
  verifyEditorNotificationsOutcome,
  verifyEditorCollaborationOutcome,
  verifyEditorPromotionOutcome,
  verifyEditorGovernanceOutcome,
  verifyEditorVariablesOutcome,
  verifyEditorFormsOutcome,
  verifyEditorFormUploadsOutcome,
  verifyEditorApprovalsOutcome,
  verifyEditorTaskTimeoutsOutcome,
} from './workspace.js';
import {
  verifyEditorApiTokensOutcome,
  verifyEditorCuratedTemplatesOutcome,
  verifyEditorPortabilityOutcome,
  verifyEditorInputCasesOutcome,
  verifyEditorDuplicationOutcome,
  verifyEditorTransformsOutcome,
  verifyEditorReadonlyOutcome,
} from './authoring.js';
import {
  verifyEditorRunValuesOutcome,
  verifyEditorCodeOutcome,
  verifyEditorWebhookResponsesOutcome,
  verifyEditorPinnedSamplesOutcome,
  verifyEditorErrorWorkflowsOutcome,
  verifyEditorCallableOutcome,
  verifyEditorFailureRoutingOutcome,
  verifyEditorArtifactInputsOutcome,
  verifyEditorSpreadsheetsOutcome,
  verifyEditorWebhookControlledHttpOutcome,
  verifyEditorScheduleOutcome,
  verifyEditorExpressionAdmissionOutcome,
  verifyEditorReceiptsOutcome,
  verifyEditorRunRecoveryOutcome,
} from './execution.js';
import { verifyEditorNestedOutcome } from './nested.js';
import { verifyEditorEmailAttachmentsOutcome } from '../evidence/notifications/email-attachments.js';

export function verifyEditorBrowserOutcome(
  context: EditorBrowserJourneyContext,
) {
  return editorOutcomeChecks[scenario](context);
}

const editorOutcomeChecks: Record<
  typeof scenario,
  (context: EditorBrowserJourneyContext) => void | Promise<void>
> = {
  'organization-oidc': verifyEditorOrganizationOidcOutcome,
  'run-values': verifyEditorRunValuesOutcome,
  'two-factor': verifyEditorTwoFactorOutcome,
  'http-pagination': verifyEditorTwoFactorOutcome,
  federation: verifyEditorFederationOutcome,
  code: verifyEditorCodeOutcome,
  'webhook-responses': verifyEditorWebhookResponsesOutcome,
  'pinned-samples': verifyEditorPinnedSamplesOutcome,
  notifications: verifyEditorNotificationsOutcome,
  collaboration: verifyEditorCollaborationOutcome,
  promotion: verifyEditorPromotionOutcome,
  governance: verifyEditorGovernanceOutcome,
  variables: verifyEditorVariablesOutcome,
  forms: verifyEditorFormsOutcome,
  'form-uploads': verifyEditorFormUploadsOutcome,
  approvals: verifyEditorApprovalsOutcome,
  'task-timeouts': verifyEditorTaskTimeoutsOutcome,
  'error-workflows': verifyEditorErrorWorkflowsOutcome,
  'api-tokens': verifyEditorApiTokensOutcome,
  callable: verifyEditorCallableOutcome,
  'curated-templates': verifyEditorCuratedTemplatesOutcome,
  portability: verifyEditorPortabilityOutcome,
  'input-cases': verifyEditorInputCasesOutcome,
  duplication: verifyEditorDuplicationOutcome,
  transforms: verifyEditorTransformsOutcome,
  'failure-routing': verifyEditorFailureRoutingOutcome,
  'artifact-inputs': verifyEditorArtifactInputsOutcome,
  spreadsheets: verifyEditorSpreadsheetsOutcome,
  'webhook-controlled-http': verifyEditorWebhookControlledHttpOutcome,
  schedule: verifyEditorScheduleOutcome,
  readonly: verifyEditorReadonlyOutcome,
  'expression-admission': verifyEditorExpressionAdmissionOutcome,
  receipts: verifyEditorReceiptsOutcome,
  'email-attachments': verifyEditorEmailAttachmentsOutcome,
  'run-recovery': verifyEditorRunRecoveryOutcome,
  'nested-conflict': verifyEditorNestedOutcome,
};
