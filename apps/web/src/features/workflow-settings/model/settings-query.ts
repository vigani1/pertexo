import type { ReadQuery } from '@/components/patterns/states/query-view';
import { isAccessLost } from '@/lib/api/error-copy';

export function visibleSettingsData<Value>(
  query: ReadQuery<Value>,
): Value | undefined {
  return query.isError && isAccessLost(query.error) ? undefined : query.data;
}
