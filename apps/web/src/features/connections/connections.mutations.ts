import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  createSlackConnection,
  revokeConnection,
  rotateSlackConnectionSecret,
  testSlackConnection,
} from './connections.api';
import { connectionKeys } from './connections.queries';

export type SlackConnectionCommand = Readonly<{
  name: string;
  botToken: string;
  idempotencyKey: string;
}>;

type ConnectionMutationScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
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
  queryClient: ReturnType<typeof useQueryClient>,
  mutationKey: readonly unknown[],
) {
  const cache = queryClient.getMutationCache();
  for (const mutation of cache.findAll({ mutationKey, exact: true }))
    cache.remove(mutation);
}

function useSecretConnectionMutation<TCommand, TResult>(
  scope: ConnectionMutationScope,
  operation: 'create' | 'rotate',
  execute: (command: TCommand) => Promise<TResult>,
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
      });
    },
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

export function useCreateSlackConnectionMutation(
  scope: ConnectionMutationScope,
) {
  return useSecretConnectionMutation(
    scope,
    'create',
    (command: SlackConnectionCommand) =>
      createSlackConnection(scope.apiClient, scope.workspaceId, command),
  );
}

export type TestConnectionCommand = Readonly<{
  connectionId: string;
  idempotencyKey: string;
}>;

export function useTestSlackConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: TestConnectionCommand) =>
      testSlackConnection(scope.apiClient, scope.workspaceId, command),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
      });
    },
  });
}

export type RotateSlackConnectionCommand = Readonly<{
  connectionId: string;
  expectedSecretVersionId: string;
  botToken: string;
  idempotencyKey: string;
}>;

export function useRotateSlackConnectionMutation(
  scope: ConnectionMutationScope,
) {
  return useSecretConnectionMutation(
    scope,
    'rotate',
    (command: RotateSlackConnectionCommand) =>
      rotateSlackConnectionSecret(scope.apiClient, scope.workspaceId, command),
  );
}

export function useRevokeConnectionMutation(scope: ConnectionMutationScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      revokeConnection(scope.apiClient, scope.workspaceId, connectionId),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: connectionKeys.scope(scope.userId, scope.workspaceId),
      });
    },
  });
}
