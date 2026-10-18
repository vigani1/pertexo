import { isApiError } from '@/lib/api/error';
import { useQueryClient } from '@tanstack/react-query';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  sendDiscussion,
  type CollaborationScope,
  type DiscussionCommand,
} from './collaboration.api';
import { collaborationKeys } from './collaboration.queries';
import type { WorkflowCommentCommandResult } from '@pertexo/contracts';
export function useDiscussionCommand(
  scope: CollaborationScope,
  onSuccess?: (result: WorkflowCommentCommandResult) => void,
) {
  const cache = useQueryClient();
  const command = useRetainedCommand(
    async (body: DiscussionCommand, key: string) => {
      try {
        return await sendDiscussion(scope, body, key);
      } catch (error) {
        if (
          isApiError(error) &&
          error.problem?.code === 'workflow.collaboration_conflict'
        )
          await cache.invalidateQueries({
            queryKey: collaborationKeys.scope(scope),
          });
        throw error;
      }
    },
    async (result) => {
      await cache.invalidateQueries({
        queryKey: collaborationKeys.scope(scope),
      });
      onSuccess?.(result);
    },
    { action: 'saving this discussion' },
  );
  return {
    ...command,
    error:
      isApiError(command.cause) &&
      command.cause.problem?.code === 'workflow.collaboration_conflict'
        ? 'This discussion changed. Your text is kept; review the latest state before trying again.'
        : command.error,
  };
}
