import { useQueryClient } from '@tanstack/react-query';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import { applyDirectoryCommand, type DirectoryCommand } from './directory.api';
import { federationSettingsQueryOptions } from './settings.queries';
import type { FederationScope } from './settings.api';
import { directoryQueryOptions } from './directory.queries';
import type { DirectorySettings } from '@pertexo/contracts';

export function useDirectoryCommand(
  scope: FederationScope,
  onApplied?: (settings: DirectorySettings | undefined) => void,
) {
  const cache = useQueryClient();
  const command = useRetainedCommand(
    (body: DirectoryCommand, key: string) =>
      applyDirectoryCommand(scope, body, key),
    async () => {
      await cache.invalidateQueries({
        queryKey: federationSettingsQueryOptions(scope).queryKey,
      });
      onApplied?.(cache.getQueryData(directoryQueryOptions(scope).queryKey));
    },
    { action: 'updating this directory' },
  );
  const cause = command.cause;
  const hasDirectoryProblemDetail =
    !command.uncertain &&
    isApiError(cause) &&
    ['workspace.conflict', 'request.invalid', 'auth.forbidden'].includes(
      cause.problem?.code ?? '',
    ) &&
    cause.problem?.detail !== undefined;
  return {
    ...command,
    error: hasDirectoryProblemDetail ? cause.problem.detail : command.error,
  };
}
