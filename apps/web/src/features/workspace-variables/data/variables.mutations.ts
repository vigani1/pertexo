import { useQueryClient } from '@tanstack/react-query';
import type {
  WorkspaceVariablesRequest,
  WorkspaceVariablesResponse,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { replaceVariables } from './variables.api';
import { variableKeys, variablesQueryOptions } from './variables.queries';

export type VariablesSaveBody = WorkspaceVariablesRequest & {
  descriptions: WorkspaceVariablesResponse['descriptions'];
};
export type AcceptedVariables = Readonly<{
  revision: number;
  values: VariablesSaveBody['values'];
  descriptions: VariablesSaveBody['descriptions'];
}>;

/**
 * Replaces the workspace's variables at the revision the edit started from.
 * The accepted set goes into the cache unless a newer one is there, after
 * `onAccepted` updates the editor.
 */
export function useVariablesSave(
  scope: WorkspaceApiScope,
  onAccepted: (accepted: AcceptedVariables) => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: VariablesSaveBody, key: string) =>
      replaceVariables(scope, body, key),
    async (result, body) => {
      const accepted = {
        revision: result.revision,
        values: body.values,
        descriptions: body.descriptions,
      };
      onAccepted(accepted);
      const key = variablesQueryOptions(scope).queryKey;
      const current = cache.getQueryData(key);
      if (current === undefined || current.revision <= accepted.revision)
        cache.setQueryData(key, accepted);
      await cache.invalidateQueries({ queryKey: variableKeys.scope(scope) });
    },
    {
      action: 'saving workspace variables',
      expiredMessage:
        'The 24-hour retry window ended. Check the current variables, then reload before saving again.',
    },
  );
}
