import { modelUsageSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import {
  assistantReadyDisclosureSchema,
  assistantUnavailableSchema,
} from './disclosure.js';

const ASSISTANT_BOUNDS = {
  answerCharacters: 6_000,
  references: 20,
  confirmationCharacters: 128,
} as const;

const runNotFailedSchema = z.strictObject({
  kind: z.literal('run_not_failed'),
});

export const explanationDisclosureSchema = z.union([
  assistantUnavailableSchema,
  runNotFailedSchema,
  assistantReadyDisclosureSchema,
]);

export const explainFailedRunRequestSchema = z.strictObject({
  confirmation: z.string().min(1).max(ASSISTANT_BOUNDS.confirmationCharacters),
});

export const explanationModelAnswerSchema = z.strictObject({
  explanation: z.string().trim().min(1).max(ASSISTANT_BOUNDS.answerCharacters),
  stepIds: z.array(z.string()).max(ASSISTANT_BOUNDS.references),
});

export const explainFailedRunResultSchema = z.union([
  assistantUnavailableSchema,
  runNotFailedSchema,
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
    kind: z.literal('explained'),
    explanation: explanationModelAnswerSchema.shape.explanation,
    steps: z
      .array(z.strictObject({ id: z.string(), label: z.string() }))
      .max(ASSISTANT_BOUNDS.references),
    usage: modelUsageSchema,
    costNanoDollars: z.int().nonnegative().nullable(),
  }),
]);
