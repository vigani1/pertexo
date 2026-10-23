import { codeDiagnosticsSchema } from '@pertexo/node-sdk';

import { z } from 'zod';
import { SAFE_EXECUTOR_ERROR_CODE_PATTERN } from '@pertexo/workflow-model';

import { ownedLeaseSchema } from './delivery.js';

// These writers produce bounded private diagnostics, including unhandled
// storage and resource refusals. Provider messages remain excluded.
const dataExecutorSummaryCodes = new Set([
  'utility.invalid_data',
  'utility.text_fields',
  'utility.result_text',
  'utility.result_too_large',
  'utility.too_many_items',
  'utility.xml_name',
  'utility.xml_data',
  'utility.xml_input',
  'utility.xml_root',
  'utility.xml_malformed',
  'utility.xml_dtd',
  'utility.xml_depth',
  'utility.xml_size',
  'utility.html_selector',
  'utility.html_depth',
  'utility.html_size',
  'utility.crypto_input',
  'utility.hmac_connection',
  'utility.hmac_unavailable',
  'file.create_data',
  'file.create_columns',
  'file.create_size',
  'file.create_storage',
]);

const safeErrorCodeSchema = z.string().regex(SAFE_EXECUTOR_ERROR_CODE_PATTERN);

export const executorFailureKindSchema = z.enum([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
]);

export const executorErrorKindSchema = z.enum([
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
]);

const completionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), output: z.unknown() }).strict(),
  z
    .object({
      status: z.literal('suspended'),
      output: z.unknown(),
      durationSeconds: z.number().int().min(1).max(2_592_000),
    })
    .strict(),
  z
    .object({
      status: z.enum(['failed', 'canceled', 'timed_out', 'outcome_unknown']),
      safeErrorCode: safeErrorCodeSchema,
      errorSummary: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('executor_failure'),
      minimumRetryDelayMillis: z.number().int().min(0).max(60_000).optional(),
      failureKind: executorFailureKindSchema,
      errorKind: executorErrorKindSchema,
      possiblyDispatched: z.boolean(),
      safeErrorCode: safeErrorCodeSchema,
      errorSummary: z.string().max(2048).optional(),
    })
    .strict()
    .refine(
      (outcome) =>
        outcome.errorSummary === undefined ||
        dataExecutorSummaryCodes.has(outcome.safeErrorCode) ||
        outcome.safeErrorCode === 'execution.file_input' ||
        outcome.safeErrorCode.startsWith('http.pagination_') ||
        outcome.safeErrorCode === 'execution.attempt_invalid',
      'Only a sanitized data, file, pagination or step-refusal diagnostic can accompany an executor failure',
    ),
]);

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();

export const connectionHealthObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('healthy') }).strict(),
  z
    .object({
      kind: z.literal('reauthorization_required'),
      reasonCode: z.enum([
        'connection.slack_account_inactive',
        'connection.slack_token_expired',
        'connection.slack_token_revoked',
      ]),
    })
    .strict(),
]);

export const completionSchema = ownedLeaseSchema
  .extend({
    outcome: completionOutcomeSchema,
    codeDiagnostics: codeDiagnosticsSchema.optional(),
    traceparent: traceparentSchema,
    connectionHealthObservation: connectionHealthObservationSchema.optional(),
  })
  .strict();
