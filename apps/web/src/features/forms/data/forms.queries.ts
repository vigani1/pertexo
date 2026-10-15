import { workflowKeys } from '@/features/workflows/queries.public';
import { queryOptions } from '@tanstack/react-query';
import {
  readForm,
  readFormAccess,
  type FormScope,
  type MemberFormScope,
} from './forms.api';
export function formQueryOptions(scope: FormScope) {
  const target = scope.target;
  return queryOptions({
    queryKey:
      target.kind === 'public'
        ? (['public-form', target.publicId, target.authority] as const)
        : ([
            'identity',
            target.userId,
            'workspace',
            target.workspaceId,
            'forms',
            target.workflowId,
            'schema',
          ] as const),
    queryFn: ({ signal }) => readForm(scope, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
export function formAccessQueryOptions(scope: MemberFormScope) {
  return queryOptions({
    queryKey: [
      ...workflowKeys.detail(scope.userId, scope.workspaceId, scope.workflowId),
      'form-access',
    ] as const,
    queryFn: ({ signal }) => readFormAccess(scope, signal),
    staleTime: 10000,
  });
}
