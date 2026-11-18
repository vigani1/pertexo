import { describe, expect, it } from 'vitest';
import { WorkflowPublishedVersionConflictError } from '@pertexo/core/runs';
import {
  ExecutionStateConflictError,
  WorkspaceAccessDeniedError,
} from '@pertexo/core/testing';
import { toProblem } from '../../src/problems/api-problem-registry.js';
import { runFailure } from '../../src/problems/context/normalize-context-errors.js';

/**
 * Run refusals a request can reach are asserted over HTTP in
 * http/run-commands.integration.test.ts. These arise only when a concurrent
 * command lands between two reads, so the real registry is checked directly.
 */
describe('run refusals that only a concurrent command can cause', () => {
  it.each([
    [
      'a publication that moved during admission',
      new WorkflowPublishedVersionConflictError(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
      'workflow.published_version_conflict',
    ],
    [
      'workspace access lost at the capacity snapshot',
      new WorkspaceAccessDeniedError('private lifecycle reason'),
      'resource.not_found',
    ],
    [
      'a cancellation that raced another',
      new ExecutionStateConflictError('execution.cancel_request_conflict'),
      'run.not_cancelable',
    ],
  ] as const)('answers %s safely', (_name, error, code) => {
    const problem = toProblem(runFailure(error));
    expect(problem.code).toBe(code);
    expect(JSON.stringify(problem)).not.toContain('private lifecycle reason');
  });
});
