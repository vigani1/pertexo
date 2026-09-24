import { isApiError } from '@/lib/api/api-error';

/** The part of a query result a section needs to render its states. */
export type SettingsQuery<Value> = Readonly<{
  data: Value | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
}>;

/**
 * Authoritative "you can't see this" answers (signed out, forbidden, or not
 * found under the API's non-disclosing policy) hide previously loaded data.
 */
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
