import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: QUERY_FRESHNESS.standard, retry: false },
      mutations: { retry: false },
    },
  });
}
