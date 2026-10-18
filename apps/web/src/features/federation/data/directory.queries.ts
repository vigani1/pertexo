import { queryOptions, infiniteQueryOptions } from '@tanstack/react-query';
import {
  readDirectory,
  readDirectoryPeople,
  readAdoptionPreview,
} from './directory.api';
import { federationSettingsQueryOptions } from './settings.queries';
import type { FederationScope } from './settings.api';
import type { DirectoryAdoptionQuery } from '@pertexo/contracts';

const directoryKey = (scope: FederationScope) =>
  [...federationSettingsQueryOptions(scope).queryKey, 'directory'] as const;
export const directoryQueryOptions = (scope: FederationScope) =>
  queryOptions({
    queryKey: directoryKey(scope),
    queryFn: ({ signal }) => readDirectory(scope, signal),
    staleTime: 30000,
    gcTime: 0,
    retry: false,
  });
export const directoryPeopleQueryOptions = (
  scope: FederationScope,
  search: string,
) =>
  infiniteQueryOptions({
    queryKey: [...directoryKey(scope), 'people', search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      readDirectoryPeople(
        scope,
        {
          search,
          limit: 50,
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30000,
    gcTime: 0,
    retry: false,
  });
export const adoptionQueryOptions = (
  scope: FederationScope,
  input: DirectoryAdoptionQuery,
) =>
  queryOptions({
    queryKey: [...directoryKey(scope), 'adoption', input],
    queryFn: ({ signal }) => readAdoptionPreview(scope, input, signal),
    staleTime: 30000,
    gcTime: 0,
    retry: false,
  });
