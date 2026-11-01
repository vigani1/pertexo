import { INBOX_RETENTION_RULE } from '../../inbox/retention.repository.js';
import {
  runInputs,
  runDetails,
  runSummaries,
} from './rules/runs.repository.js';
import {
  dataTableReceipts,
  webhookResponses,
  nodeDetails,
  events,
  checkpoints,
} from './rules/run-records.repository.js';
import { auditHistory, connectionHistory } from './rules/audit.repository.js';
import {
  webhookReplays,
  webhookDeliveries,
  coordinatedEvents,
  eventWindows,
  scheduleOccurrences,
} from './rules/triggers.repository.js';
import {
  testSnapshots,
  inputPayloads,
  deletedInputCases,
  stepSamples,
  webhookTests,
} from './rules/authoring.repository.js';
import { unsentAuthenticationMail } from './rules/identity.repository.js';
import {
  invitationExpiry,
  acceptanceIntents,
  invitationRecipients,
} from './rules/invitations.repository.js';
import {
  presence,
  publicationRequests,
  triggerSkips,
  previewUsage,
  testSuites,
  transportFacts,
  commandReceipts,
  creationReceipts,
  startRejections,
} from './rules/metadata.repository.js';
import {
  provisioningCredentials,
  sessions,
  methodLinkAttempts,
  federationAttempts,
  signInAttempts,
  emailProofs,
  identityFacts,
  authenticationMail,
} from './rules/identity.repository.js';

import { CALLBACK_TASK_RETENTION_RULE } from '../../runs/pending-tasks/callbacks/retention.js';
import { RUN_VALUES_RETENTION_RULE } from '../../runs/values/retention.js';

import { VARIABLE_SET_RETENTION_RULE } from '../../variables/retention.repository.js';
import { API_TOKEN_RETENTION_RULE } from './rules/api-tokens.repository.js';
import { reapInvitationReplacementClaims } from './rules/invitation-claims.repository.js';
import {
  CALL_CHILD_REFERENCES_RETENTION_RULE,
  CALL_DETAILS_RETENTION_RULE,
} from './rules/calls.repository.js';

/**
 * What retention removes and when. Each rule clears or deletes at most one page
 * of rows per call, and one worker at a time runs a given rule. Later rules
 * depend on earlier ones: a run summary is deleted only once its details are
 * gone and no trigger record or replay still refers to it.
 *
 * A rule that deletes rows someone may still change repeats its condition on
 * the deleted row, so a row changed while the delete waited for it is kept.
 */
export const RETENTION_RULES = Object.freeze([
  API_TOKEN_RETENTION_RULE,
  RUN_VALUES_RETENTION_RULE,
  presence,

  provisioningCredentials,
  publicationRequests,
  dataTableReceipts,
  triggerSkips,
  previewUsage,
  testSuites,
  testSnapshots,
  webhookResponses,
  runInputs,
  CALLBACK_TASK_RETENTION_RULE,
  nodeDetails,
  events,
  checkpoints,
  CALL_DETAILS_RETENTION_RULE,
  runDetails,
  webhookReplays,
  webhookDeliveries,
  coordinatedEvents,
  eventWindows,
  scheduleOccurrences,
  CALL_CHILD_REFERENCES_RETENTION_RULE,
  runSummaries,
  auditHistory,
  connectionHistory,
  transportFacts,
  commandReceipts,
  creationReceipts,
  startRejections,
  sessions,
  methodLinkAttempts,
  federationAttempts,
  signInAttempts,
  emailProofs,
  INBOX_RETENTION_RULE,
  identityFacts,
  unsentAuthenticationMail,
  authenticationMail,
  invitationExpiry,
  acceptanceIntents,
  {
    name: 'invitation_replacement_claims',
    run: reapInvitationReplacementClaims,
  },
  invitationRecipients,
  inputPayloads,
  deletedInputCases,
  stepSamples,
  webhookTests,
  VARIABLE_SET_RETENTION_RULE,
] as const);

export type RetentionRuleName = (typeof RETENTION_RULES)[number]['name'];
