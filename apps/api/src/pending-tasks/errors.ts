import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
} from '@pertexo/database/runs';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
export async function taskOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof PendingTaskNotFoundError ||
      error instanceof WorkspaceAccessDeniedError
    )
      return throwApplicationError(applicationError('resource.not_found'));
    if (error instanceof IdempotencyConflictError)
      return throwApplicationError(
        applicationError('request.idempotency_conflict'),
      );
    if (error instanceof PendingTaskDecisionError) {
      const problems = {
        resolved: [
          'pending_task.already_resolved',
          'Someone already resolved this task. Refresh to see the decision.',
        ],
        expired: [
          'pending_task.expired',
          'This task expired. The run will follow its failure path.',
        ],
        run_closed: [
          'pending_task.run_closed',
          'This run was canceled, finished, or reached its deadline.',
        ],
        starter: [
          'pending_task.self_decision',
          'The person who started this run cannot decide its approval. Ask another eligible member.',
        ],
        audience: [
          'pending_task.not_eligible',
          'Your current membership is not in this task’s allowed audience.',
        ],
      } as const;
      const [code, safeDetail] = problems[error.reason];
      return throwApplicationError(applicationError(code, { safeDetail }));
    }
    throw error;
  }
}
