import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GovernanceSettings } from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import { saveSettings, type GovernanceScope } from '../data/audit.api';
import { governanceKeys, governanceQueryOptions } from '../data/audit.queries';
import { settingEdit, type SettingField } from '../model/setting-edit';

/** One governance setting's form: its base, its save, and whether it's out of date. */
export function useSettingForm<Field extends SettingField>(
  scope: GovernanceScope,
  snapshot: GovernanceSettings,
  field: Field,
  options: Readonly<{ action: string }>,
) {
  const cache = useQueryClient();
  const [base, setBase] = useState(snapshot);
  const refresh = () =>
    cache.invalidateQueries({ queryKey: governanceKeys.scope(scope) });
  const command = useRetainedCommand(
    async (
      body: { expectedRevision: number } & Pick<GovernanceSettings, Field>,
      key: string,
    ) => {
      try {
        return await saveSettings(scope, body, key);
      } catch (error) {
        // The refusal means this page is behind; catching up lets the next save work.
        if (isApiError(error) && error.problem?.code === 'workspace.conflict')
          void refresh();
        throw error;
      }
    },
    async (saved) => {
      setBase(saved);
      cache.setQueryData(governanceQueryOptions(scope).queryKey, saved);
      await refresh();
    },
    options,
  );
  return {
    base,
    command,
    ...settingEdit(base, snapshot, field),
    adoptSnapshot: () => {
      setBase(snapshot);
      command.reset();
    },
  };
}
