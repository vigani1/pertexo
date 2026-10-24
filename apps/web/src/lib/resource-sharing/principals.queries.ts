import { infiniteQueryOptions } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import { readSharingPrincipals } from './principals.api';
export function sharingPrincipalsQueryOptions({
  api,
  userId,
  workspaceId,
  kind,
  search,
}: Readonly<{
  api: ApiClient;
  userId: string;
  workspaceId: string;
  kind: 'member' | 'group';
  search: string;
}>) {
  return infiniteQueryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'sharing-principals',
      kind,
      search,
    ] as const,
    maxPages: 5,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      readSharingPrincipals(
        api,
        workspaceId,
        {
          kind,
          search,
          limit: 20,
          ...(pageParam === null ? {} : { after: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.next ?? undefined,
    retry: false,
  });
}
