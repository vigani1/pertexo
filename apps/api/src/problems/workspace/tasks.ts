import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
} from '@pertexo/core/runs';
import { applicationError } from '../../platform/http/index.js';

export const tasksProblems = [
  errorRegistration(PendingTaskNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(PendingTaskDecisionError, (error) => {
    const problems = {
      resolved: [
        'pending_task.already_resolved',
        'Someone already resolved this task. Refresh to see the decision.',
      ],
      expired: [
        'pending_task.expired',
        'This task expired and no longer accepts a response. The run continues on its Timed out path or fails the step, as the step’s setup says.',
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
      workspace_suspended: [
        'pending_task.not_eligible',
        'This workspace is suspended, so nobody can respond until it is reactivated.',
      ],
    } as const;
    const [code, safeDetail] = problems[error.reason];
    return applicationError(code, { safeDetail });
  }),
];
