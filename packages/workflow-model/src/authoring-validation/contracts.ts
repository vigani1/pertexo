import { availableParallelism } from 'node:os';
import { z } from 'zod';
import { GRAPH_ISSUE_CODES } from '../graph/validation-contract.js';
import { WORKFLOW_VALIDATION_MAX_ISSUES } from '../graph/contract.js';

/** Operational admission, not expression-language or graph limits. */
export const AUTHORING_VALIDATION_BUDGET = Object.freeze({
  maxActive: Math.min(2, availableParallelism()),
  maxQueued: 4,
  maxQueuedBytes: 4 * 1_048_576,
  envelopeBytes: 2 * 1_048_576,
  queueMs: 500,
  startupMs: 500,
  parseMs: 1_000,
  terminationMs: 250,
  reportBytes: 262_144,
  messageBytes: 512,
});

export const policyProjectionSchema = z
  .object({
    definitions: z
      .array(
        z
          .object({
            definition: z
              .object({
                key: z.string().min(1),
                version: z.number().int().positive(),
              })
              .strict(),
            policyReferences: z
              .array(
                z
                  .object({
                    key: z.string().min(1),
                    version: z.number().int().positive(),
                  })
                  .strict(),
              )
              .readonly(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

/** The policies each catalog definition allows its expressions to use. */
export type WorkflowExpressionPolicyProjection = z.infer<
  typeof policyProjectionSchema
>;

export type AuthoringValidationUnavailableReason =
  | 'closed'
  | 'canceled'
  | 'overloaded'
  | 'payload_limit'
  | 'queue_timeout'
  | 'startup_timeout'
  | 'parse_timeout'
  | 'worker_failed'
  | 'invalid_response'
  | 'termination_failed'
  | 'report_limit'
  | 'invalid_policy_projection'
  | 'not_configured'
  | 'database_budget';

/** Never retains a graph, AST, original exception, or expression text. */
export class AuthoringValidationUnavailableError extends Error {
  constructor(readonly reason: AuthoringValidationUnavailableReason) {
    super('Workflow validation is temporarily unavailable.');
    this.name = 'AuthoringValidationUnavailableError';
  }
}

const totals = {
  expandedInvocations: z.number().int().nonnegative(),
  worstCaseLoopIterations: z.number().int().nonnegative(),
};
export const validationReportSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), issues: z.tuple([]), ...totals }).strict(),
  z
    .object({
      ok: z.literal(false),
      issues: z
        .array(
          z
            .object({
              code: z.enum(GRAPH_ISSUE_CODES),
              path: z.string(),
              message: z.string(),
            })
            .strict(),
        )
        .min(1)
        .max(WORKFLOW_VALIDATION_MAX_ISSUES),
      ...totals,
    })
    .strict(),
]);
