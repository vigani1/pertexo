import { isApiError } from '@/lib/api/api-error';

export type SettingsQuery<Value> = Readonly<{
  data: Value | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}>;

export function settingsQueryIsUnavailable(
  query: SettingsQuery<unknown>,
): boolean {
  return (
    query.isError &&
    isApiError(query.error) &&
    [401, 403, 404].includes(query.error.status ?? 0)
  );
}

export function visibleSettingsData<Value>(
  query: SettingsQuery<Value>,
): Value | undefined {
  return settingsQueryIsUnavailable(query) ? undefined : query.data;
}
