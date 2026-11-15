import { z } from 'zod';

export const NODE_EXECUTOR_FAILURE_KINDS = Object.freeze([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
] as const);
export const NODE_EXECUTOR_ERROR_KINDS = Object.freeze([
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
] as const);
/** The longest wait before a retry, whether a service or a step asks for it. */
export const MAXIMUM_RETRY_DELAY_MILLIS = 60_000;
export type NodeExecutorFailureKind =
  (typeof NODE_EXECUTOR_FAILURE_KINDS)[number];
export type NodeExecutorErrorKind = (typeof NODE_EXECUTOR_ERROR_KINDS)[number];
/** The longest origin/path representation retained with a service refusal. */
export const MAXIMUM_SERVICE_RESPONSE_URL_CHARACTERS = 512;
/** The longest response excerpt a failure keeps. */
export const MAXIMUM_RESPONSE_EXCERPT_CHARACTERS = 1_500;
export const NODE_FAILURE_FIELD_LIMITS = Object.freeze({
  methodCharacters: 16,
  safeErrorCodeCharacters: 128,
  errorSummaryCharacters: 2_048,
});
// HTTP status codes are three digits from 100 to 599.
const HTTP_STATUS_RANGE = Object.freeze({ minimum: 100, maximum: 599 });
export const serviceResponseSchema = z
  .object({
    method: z.string().min(1).max(NODE_FAILURE_FIELD_LIMITS.methodCharacters),
    /** Origin and path only: a query can hold credentials. */
    url: z.url().max(MAXIMUM_SERVICE_RESPONSE_URL_CHARACTERS),
    status: z
      .number()
      .int()
      .min(HTTP_STATUS_RANGE.minimum)
      .max(HTTP_STATUS_RANGE.maximum),
    /** Already redacted by the secure HTTP client, and bounded here. */
    body: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('text'),
        excerpt: z.string().max(MAXIMUM_RESPONSE_EXCERPT_CHARACTERS + 1),
      }),
      z.object({ kind: z.enum(['none', 'binary', 'too_large']) }),
    ]),
  })
  .strict();
export type ServiceResponseFacts = Readonly<
  z.output<typeof serviceResponseSchema>
>;
export type NodeExecutorFailureOutcome = Readonly<{
  kind: NodeExecutorFailureKind;
  errorKind: NodeExecutorErrorKind;
  possiblyDispatched: boolean;
  minimumRetryDelayMillis?: number;
  /** Fixed, content-free diagnostics supplied by the executor, never provider text. */
  safeErrorCode?: string;
  errorSummary?: string;
  /** What the called service answered. Its own channel, since it is provider text. */
  serviceResponse?: ServiceResponseFacts;
}>;
export const nodeExecutorFailureSchema = z
  .object({
    kind: z.enum(NODE_EXECUTOR_FAILURE_KINDS),
    errorKind: z.enum(NODE_EXECUTOR_ERROR_KINDS),
    possiblyDispatched: z.boolean(),
    minimumRetryDelayMillis: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_RETRY_DELAY_MILLIS)
      .optional(),
    safeErrorCode: z
      .string()
      .min(1)
      .max(NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters)
      .regex(/^[a-z][a-z0-9_.]*$/u)
      .optional(),
    errorSummary: z
      .string()
      .min(1)
      .max(NODE_FAILURE_FIELD_LIMITS.errorSummaryCharacters)
      .optional(),
    serviceResponse: serviceResponseSchema.optional(),
  })
  .strict();
