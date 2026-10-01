import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  workflowConcurrencyRevisionConflictProblemSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  type WorkflowConcurrencySettingsRequest,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import { putWorkflowConcurrency } from '../concurrency.api';
import { concurrencyKey } from '../concurrency.queries';
import { settingsCommandError } from './settings-command';

function commandProblem(error: unknown, revisionConflict: boolean): string {
  if (revisionConflict)
    return 'This changed in another session. Your edits are kept. Review the refreshed limit, then save again.';
  if (isUncertainOutcome(error))
    return settingsCommandError(error, 'saving concurrency settings');
  if (isApiError(error)) {
    const exceeded = workflowConcurrencyLimitExceededProblemSchema.safeParse(
      error.problemDetails,
    );
    if (exceeded.success)
      return `The workspace now allows at most ${String(exceeded.data.maximum)} active runs. Review the refreshed allowance and choose a lower limit.`;
    if (error.problem?.code === 'workflow.concurrency_limit_unavailable')
      return 'There is no active workspace execution allowance for setting a limit. You can still remove the workflow limit.';
  }
  return describeCommandError(error, 'saving concurrency settings');
}

export function useConcurrencyCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const cache = useQueryClient();
  const attempt = useRef<
    | Readonly<{ body: WorkflowConcurrencySettingsRequest; key: string }>
    | undefined
  >(undefined);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  async function send(
    body: WorkflowConcurrencySettingsRequest,
  ): Promise<boolean> {
    if (
      sending.current ||
      (attempt.current !== undefined &&
        JSON.stringify(attempt.current.body) !== JSON.stringify(body))
    )
      return false;
    const request = attempt.current ?? { body, key: crypto.randomUUID() };
    attempt.current = request;
    sending.current = true;
    setPending(true);
    setProblem(undefined);
    setConflict(false);
    try {
      await putWorkflowConcurrency(
        apiClient,
        workspaceId,
        workflowId,
        request.body,
        request.key,
      );
      attempt.current = undefined;
      setUnconfirmed(false);
      return true;
    } catch (error: unknown) {
      const uncertain = isUncertainOutcome(error);
      const revisionConflict =
        isApiError(error) &&
        error.kind === 'problem' &&
        workflowConcurrencyRevisionConflictProblemSchema.safeParse(
          error.problemDetails,
        ).success;
      if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
        cache
          .getQueryCache()
          .find({
            queryKey: concurrencyKey(userId, workspaceId, workflowId),
            exact: true,
          })
          ?.setState({ data: undefined, dataUpdatedAt: 0 });
      if (!uncertain) attempt.current = undefined;
      setUnconfirmed(uncertain);
      setConflict(revisionConflict);
      setProblem(commandProblem(error, revisionConflict));
      return false;
    } finally {
      // An idempotent receipt is not proof of current settings or authority.
      await cache.invalidateQueries({
        queryKey: concurrencyKey(userId, workspaceId, workflowId),
      });
      sending.current = false;
      setPending(false);
    }
  }
  return {
    pending,
    problem,
    unconfirmed,
    conflict,
    send,
    retry: () =>
      attempt.current === undefined
        ? Promise.resolve(false)
        : send(attempt.current.body),
  };
}
