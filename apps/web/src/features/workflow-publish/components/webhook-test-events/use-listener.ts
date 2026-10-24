import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WebhookAuthentication,
  WebhookTestEventStarted,
} from '@pertexo/contracts';
import type { SampleScope } from '../../data/samples/api';
import {
  startWebhookTest,
  stopWebhookTest,
} from '../../data/webhook-test-events/api';
import { webhookTestQuery } from '../../data/webhook-test-events/queries';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';

export function useWebhookListener({
  scope,
  nodeId,
  binding,
  ensureSaved,
  active,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  binding: string | undefined;
  ensureSaved: () => Promise<{ revision: number }>;
  active: boolean;
}>) {
  const client = useQueryClient();
  const [listener, setListener] = useState<
    WebhookTestEventStarted & {
      binding: string | undefined;
      openedAtMillis: number;
    }
  >();
  const { apiClient, userId, workspaceId, workflowId } = scope;
  const lifetime = useRef<AbortController | undefined>(undefined);
  const current = useRef<WebhookTestEventStarted | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      const active = current.current;
      if (active !== undefined)
        void stopWebhookTest(
          { apiClient, userId, workspaceId, workflowId },
          nodeId,
          active.id,
          AbortSignal.timeout(3000),
        ).catch(() => undefined);
    };
  }, [apiClient, workspaceId, workflowId, userId, nodeId]);
  const start = useMutation({
    mutationFn: async (authentication: WebhookAuthentication) => {
      const signal = lifetime.current?.signal;
      if (signal === undefined || signal.aborted)
        throw new DOMException('Aborted', 'AbortError');
      const isCurrent = () =>
        lifetime.current?.signal === signal && !signal.aborted;
      const { revision } = await ensureSaved();
      signal.throwIfAborted();
      const result = await startWebhookTest(
        scope,
        nodeId,
        { expectedDraftRevision: revision, authentication },
        signal,
      );
      if (!isCurrent()) {
        void stopWebhookTest(
          scope,
          nodeId,
          result.id,
          AbortSignal.timeout(3000),
        ).catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      current.current = result;
      setListener({ ...result, binding, openedAtMillis: Date.now() });
      // The generated credential belongs only to this mounted panel, never the mutation cache.
      return { id: result.id, expiresAt: result.expiresAt };
    },
    onSuccess: (result) => {
      client.setQueryData(webhookTestQuery(scope, nodeId, result.id).queryKey, {
        state: 'waiting',
        expiresAt: result.expiresAt,
        output: null,
      });
    },
  });
  const stop = useMutation({
    mutationFn: async () => {
      if (listener === undefined) return;
      await stopWebhookTest(
        scope,
        nodeId,
        listener.id,
        AbortSignal.timeout(5000),
      );
      return listener.id;
    },
    onSuccess: async (id) => {
      if (id === undefined) return;
      const queryKey = webhookTestQuery(scope, nodeId, id).queryKey;
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, {
        state: 'expired',
        expiresAt: null,
        output: null,
      });
      current.current = undefined;
      setListener(undefined);
    },
  });
  const changed = listener !== undefined && listener.binding !== binding;
  const query = useQuery({
    ...webhookTestQuery(scope, nodeId, listener?.id ?? ''),
    enabled: active && listener !== undefined && !changed,
  });
  function errorMessage(): string | undefined {
    if (start.error !== null) return listenerError(start.error);
    if (stop.error !== null)
      return describeCommandError(
        stop.error,
        'stopping the webhook test listener',
      );
    return undefined;
  }
  return {
    listener,
    start,
    stop,
    query,
    changed,
    error: errorMessage(),
  };
}

function listenerError(error: unknown): string {
  if (isApiError(error)) {
    if (error.problem?.code === 'webhook.not_configured')
      return 'Webhook testing is off because the server has no webhook encryption configured. Ask the instance owner to configure it.';
    if (error.problem?.code === 'workspace.conflict')
      return error.problem.detail ?? 'Save the current draft and listen again.';
  }
  return describeCommandError(error, 'starting the webhook test listener');
}
