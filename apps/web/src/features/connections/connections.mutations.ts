import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo } from 'react';
import type {
  ConnectionCreateRequest,
  ConnectionResponse,
  ConnectionTestRequest,
} from '@pertexo/contracts/schemas/connections';
import type { ApiClient } from '@/lib/api/client';
import {
  createConnection,
  revokeConnection,
  rotateConnectionSecret,
  testConnection,
  type ConnectionCredential,
} from './connections.api';
import { connectionKeys } from './connections.queries';

export type ConnectionMutationScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

export type CreateConnectionCommand = Readonly<{
  request: ConnectionCreateRequest;
  idempotencyKey: string;
}>;

export type RotateConnectionCommand = Readonly<{
  connectionId: string;
  expectedSecretVersionId: string;
  credential: ConnectionCredential;
  idempotencyKey: string;
}>;

export type TestConnectionCommand = Readonly<{
  connectionId: string;
  request: ConnectionTestRequest;
  idempotencyKey: string;
}>;

function secretMutationKey(
  userId: string,
  workspaceId: string,
  operation: 'create' | 'rotate',
  ownerId: string,
) {
  return [
    'connections',
    userId,
    workspaceId,
    'secret-command',
    operation,
    ownerId,
  ] as const;
}

function removeSecretMutation(
  queryClient: QueryClient,
  mutationKey: readonly unknown[],
) {
  const cache = queryClient.getMutationCache();
  for (const mutation of cache.findAll({ mutationKey, exact: true }))
    cache.remove(mutation);
}

async function storeConnection(
  queryClient: QueryClient,
  scope: ConnectionMutationScope,
  connection: ConnectionResponse,
) {
  queryClient.setQueryData(
    connectionKeys.detail(scope.userId, scope.workspaceId, connection.id),
    connection,
  );
  await queryClient.invalidateQueries({
    queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
    predicate: (query) =>
      query.queryKey.at(-1) !== connection.id ||
      query.queryKey.at(-2) !== 'detail',
  });
}

/**
 * Credential commands carry secrets in their variables, so their mutation
 * entries are removed from the cache as soon as the owning form lets go.
 */
function useSecretConnectionMutation<Command, Result>(
  scope: ConnectionMutationScope,
  operation: 'create' | 'rotate',
  execute: (command: Command) => Promise<Result>,
  onSettledResult: (result: Result) => Promise<void>,
) {
  const queryClient = useQueryClient();
  const ownerId = useId();
  const mutationKey = useMemo(
    () =>
      secretMutationKey(scope.userId, scope.workspaceId, operation, ownerId),
    [operation, ownerId, scope.userId, scope.workspaceId],
  );
  const mutation = useMutation({
    mutationKey,
    mutationFn: execute,
    onSuccess: onSettledResult,
  });
  const reset = mutation.reset;
  const clearSensitiveState = useCallback(() => {
    reset();
    removeSecretMutation(queryClient, mutationKey);
  }, [mutationKey, queryClient, reset]);
  useEffect(
    () => () => {
      removeSecretMutation(queryClient, mutationKey);
    },
    [mutationKey, queryClient],
  );
  return { mutation, clearSensitiveState } as const;
}

export function useCreateConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useSecretConnectionMutation(
    scope,
    'create',
    (command: CreateConnectionCommand) =>
      createConnection(scope.apiClient, scope.workspaceId, command),
    (connection) => storeConnection(queryClient, scope, connection),
  );
}

export function useRotateConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useSecretConnectionMutation(
    scope,
    'rotate',
    (command: RotateConnectionCommand) =>
      rotateConnectionSecret(scope.apiClient, scope.workspaceId, command),
    (connection) => storeConnection(queryClient, scope, connection),
  );
}

export function useTestConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: TestConnectionCommand) =>
      testConnection(scope.apiClient, scope.workspaceId, command),
    onSuccess: (result) =>
      storeConnection(queryClient, scope, result.connection),
  });
}

export function useRevokeConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      revokeConnection(scope.apiClient, scope.workspaceId, connectionId),
    onSuccess: (connection) => storeConnection(queryClient, scope, connection),
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
      }),
  });
}
