import type { ReadQuery } from '@/components/patterns/states/query-view';
import { isApiError } from '@/lib/api/error';

/**
 * Authoritative "you can't see this" answers (signed out, forbidden, or not
 * found under the API's non-disclosing policy) hide previously loaded data.
 */
export function settingsReadIsUnavailable(error: unknown): boolean {
  return isApiError(error) && [401, 403, 404].includes(error.status ?? 0);
}

export function visibleSettingsData<Value>(
  query: ReadQuery<Value>,
): Value | undefined {
  return query.isError && settingsReadIsUnavailable(query.error)
    ? undefined
    : query.data;
}
