import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { logoutSession } from '../../data/auth.api';
import { isUnauthenticated } from './errors';
import { publishSessionChange } from './sync';

export async function endBrowserSession(
  apiClient: ApiClient,
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.cancelQueries();
  try {
    await logoutSession(apiClient);
  } catch (error) {
    if (!isUnauthenticated(error)) throw error;
  }
  queryClient.clear();
  publishSessionChange();
}
