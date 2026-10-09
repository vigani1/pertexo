import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type {
  ConnectionCreateRequest,
  ConnectionResponse,
  ConnectionTestRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  createConnection,
  revokeConnection,
  rotateConnectionSecret,
  testConnection,
  type ConnectionCredential,
} from './connections.api';
import { connectionKeys } from './connections.queries';
import {
  connectionCommandAccessLost,
  forgetDeniedConnections,
} from './connection-access';

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
  isCurrent: () => boolean,
) {
  await queryClient.cancelQueries({
    queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
  });
  if (!isCurrent()) return;
  queryClient.setQueryData(
    connectionKeys.detail(scope.userId, scope.workspaceId, connection.id),
    connection,
  );
  await queryClient.invalidateQueries({
    queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
  });
}

function useConnectionResultScope(scope: ConnectionMutationScope) {
  const owners = useRef(new Set<object>());
  const generation = useMemo(
    () => ({ userId: scope.userId, workspaceId: scope.workspaceId }),
    [scope.userId, scope.workspaceId],
  );
  useEffect(() => {
    const active = owners.current;
    active.add(generation);
    return () => {
      active.delete(generation);
    };
  }, [generation]);
  const isCurrent = () => owners.current.has(generation);
  const queryClient = useQueryClient();
  return {
    invalidate: () =>
      isCurrent()
        ? queryClient.invalidateQueries({
            queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
          })
        : Promise.resolve(),
    store: (connection: ConnectionResponse) =>
      isCurrent()
        ? storeConnection(queryClient, scope, connection, isCurrent)
        : Promise.resolve(),
    denied: (error: unknown) => {
      if (!isCurrent() || !connectionCommandAccessLost(error))
        return Promise.resolve();
      return forgetDeniedConnections(
        queryClient,
        connectionKeys.scope(scope.userId, scope.workspaceId),
        ['connection-command'],
        error,
      );
    },
  };
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
  onError: (error: unknown) => Promise<void>,
) {
  const queryClient = useQueryClient();
  const ownerId = useId();
  const mutationKey = useMemo(
    () =>
      secretMutationKey(scope.userId, scope.workspaceId, operation, ownerId),
    [operation, ownerId, scope.userId, scope.workspaceId],
  );
  // Each command passes its cache update (storing the returned connection)
  // as `onSettledResult`.
  const mutation = useMutation({
    mutationKey,
    mutationFn: execute,
    onMutate: () => ({ onSettledResult, onError }),
    onSuccess: (result, _command, owner) => owner.onSettledResult(result),
    onError: (error, _command, owner) => owner?.onError(error),
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
  const resultScope = useConnectionResultScope(scope);
  return useSecretConnectionMutation(
    scope,
    'create',
    (command: CreateConnectionCommand) =>
      createConnection(scope.apiClient, scope.workspaceId, command),
    resultScope.store,
    resultScope.denied,
  );
}

export function useRotateConnectionMutation(scope: ConnectionMutationScope) {
  const resultScope = useConnectionResultScope(scope);
  return useSecretConnectionMutation(
    scope,
    'rotate',
    (command: RotateConnectionCommand) =>
      rotateConnectionSecret(scope.apiClient, scope.workspaceId, command),
    resultScope.store,
    resultScope.denied,
  );
}

export function useTestConnectionMutation(scope: ConnectionMutationScope) {
  const resultScope = useConnectionResultScope(scope);
  return useMutation({
    mutationFn: (command: TestConnectionCommand) =>
      testConnection(scope.apiClient, scope.workspaceId, command),
    onMutate: () => resultScope,
    onSuccess: (result, _command, owner) => owner.store(result.connection),
    onError: (error, _command, owner) => owner?.denied(error),
  });
}

export function useRevokeConnectionMutation(scope: ConnectionMutationScope) {
  const resultScope = useConnectionResultScope(scope);
  return useMutation({
    mutationFn: (connectionId: string) =>
      revokeConnection(scope.apiClient, scope.workspaceId, connectionId),
    onMutate: () => resultScope,
    onSuccess: (result, _command, owner) => owner.store(result),
    onError: async (error, _command, owner) => {
      await owner?.denied(error);
      await owner?.invalidate();
    },
  });
}
