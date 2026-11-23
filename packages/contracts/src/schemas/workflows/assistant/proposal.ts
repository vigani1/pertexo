import { modelUsageSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import {
  strongEtagSchema,
  workflowDraftResponseSchema,
  workflowValidateResponseSchema,
} from '../authoring.js';
import {
  assistantReadyDisclosureSchema,
  assistantUnavailableSchema,
} from './disclosure.js';
import { explainFailedRunRequestSchema } from './explanation.js';

export const DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS = 4_000;
export const PROPOSAL_CORRECTION_ROUNDS = 2;
const rounds = z.int().min(0).max(PROPOSAL_CORRECTION_ROUNDS);

export const draftProposalDisclosureSchema = z.union([
  assistantUnavailableSchema,
  assistantReadyDisclosureSchema,
]);

export const draftProposalRequestSchema = explainFailedRunRequestSchema.extend({
  request: z.string().trim().min(1).max(DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS),
});

export const draftProposalResultSchema = z.union([
  assistantUnavailableSchema,
  z.strictObject({
    kind: z.enum([
      'confirmation_changed',
      'timeout',
      'response_too_large',
      'request_too_large',
      'invalid_response',
      'provider_failure',
    ]),
    usage: modelUsageSchema.optional(),
    rounds: rounds.optional(),
  }),
  z.strictObject({
    kind: z.literal('rejected'),
    issues: workflowValidateResponseSchema.shape.issues,
    usage: modelUsageSchema,
    rounds: rounds.optional(),
  }),
  z.strictObject({
    kind: z.literal('inspected'),
    base: workflowDraftResponseSchema,
    draft: workflowDraftResponseSchema,
    representationTag: strongEtagSchema,
    validation: workflowValidateResponseSchema,
    usage: modelUsageSchema,
    rounds: rounds.optional(),
  }),
]);

export type DraftProposalResult = z.output<typeof draftProposalResultSchema>;
