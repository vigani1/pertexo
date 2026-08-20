import { z } from 'zod';

export const API_PROBLEM_CODES = [
  'auth.unauthenticated',
  'auth.forbidden',
  'resource.not_found',
  'request.invalid',
  'request.idempotency_conflict',
  'workspace.quota_exceeded',
  'workspace.conflict',
  'workflow.revision_conflict',
  'workflow.invalid',
  'workflow.not_published',
  'workflow.activation_failed',
  'run.not_cancelable',
  'run.outcome_unknown',
  'connection.reauthorization_required',
  'provider.rate_limited',
  'provider.unavailable',
  'internal.unexpected',
] as const;

export const apiProblemCodeSchema = z.enum(API_PROBLEM_CODES);

export const apiProblemIssueSchema = z
  .object({
    path: z.string().max(1_024),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(500),
  })
  .strict()
  .readonly();

export const apiProblemSchema = z
  .object({
    type: z.string().min(1).max(256),
    title: z.string().min(1).max(256),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1).max(2_000).optional(),
    instance: z.string().min(1).max(2_048).optional(),
    code: apiProblemCodeSchema,
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    errors: z.array(apiProblemIssueSchema).max(100).readonly().optional(),
  })
  .strict()
  .readonly();

export type ApiProblemCode = z.output<typeof apiProblemCodeSchema>;
export type ApiProblemIssue = z.output<typeof apiProblemIssueSchema>;
export type ApiProblem = z.output<typeof apiProblemSchema>;
