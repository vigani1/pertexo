import type { ApiProblem } from '@pertexo/contracts';
import {
  workflowConcurrencyLimitSchema,
  workflowConcurrencyRevisionSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  workflowConcurrencyRevisionConflictProblemSchema,
} from '@pertexo/contracts';
import type { ApplicationError } from '../application-error.js';

export type ConcurrencyConflict =
  | Readonly<{
      code: 'workflow.concurrency_revision_conflict';
      currentRevision: number;
    }>
  | Readonly<{ code: 'workflow.concurrency_limit_exceeded'; maximum: number }>;
export function normalizeConcurrencyConflict(
  error: ApplicationError,
): ConcurrencyConflict | undefined {
  if (error.code === 'workflow.concurrency_revision_conflict')
    return {
      code: error.code,
      currentRevision: workflowConcurrencyRevisionSchema.parse(
        error.details?.currentRevision,
      ),
    };
  if (error.code === 'workflow.concurrency_limit_exceeded')
    return {
      code: error.code,
      maximum: workflowConcurrencyLimitSchema.parse(error.details?.maximum),
    };
  return undefined;
}
export function projectConcurrencyConflict(
  base: ApiProblem,
  conflict: ConcurrencyConflict,
) {
  return conflict.code === 'workflow.concurrency_revision_conflict'
    ? workflowConcurrencyRevisionConflictProblemSchema.parse({
        ...base,
        ...conflict,
      })
    : workflowConcurrencyLimitExceededProblemSchema.parse({
        ...base,
        ...conflict,
      });
}
