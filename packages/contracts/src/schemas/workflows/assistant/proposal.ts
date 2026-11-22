import { modelUsageSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import {
  strongEtagSchema,
  workflowDraftResponseSchema,
  workflowValidateResponseSchema,
} from '../authoring.js';
import {
  explainFailedRunRequestSchema,
  explanationDisclosureSchema,
} from './explanation.js';

export const DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS = 4_000;

const unavailable = z.strictObject({
  kind: z.enum(['not_configured', 'connection_unavailable']),
});

export const draftProposalDisclosureSchema = z.union([
  unavailable,
  explanationDisclosureSchema.options[1],
]);

export const draftProposalRequestSchema = explainFailedRunRequestSchema.extend({
  request: z.string().trim().min(1).max(DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS),
});

export const draftProposalResultSchema = z.union([
  unavailable,
  z.strictObject({
    kind: z.enum([
      'confirmation_changed',
      'timeout',
      'response_too_large',
      'invalid_response',
      'provider_failure',
    ]),
    usage: modelUsageSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('rejected'),
    issues: workflowValidateResponseSchema.shape.issues,
    usage: modelUsageSchema,
  }),
  z.strictObject({
    kind: z.literal('inspected'),
    base: workflowDraftResponseSchema,
    draft: workflowDraftResponseSchema,
    representationTag: strongEtagSchema,
    validation: workflowValidateResponseSchema,
    usage: modelUsageSchema,
  }),
]);

export type DraftProposalResult = z.output<typeof draftProposalResultSchema>;
