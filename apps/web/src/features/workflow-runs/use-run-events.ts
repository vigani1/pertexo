import type { WorkflowRunEvent } from '@pertexo/contracts/schemas/workflow-runs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { decodeSseMessages } from '@/lib/api/sse';
import { openWorkflowRunEvents } from './workflow-runs.api';
import { workflowRunQueryOptions } from './workflow-runs.queries';
import {
  appendRunEvent,
  classifyRunEvent,
  decodeRunEvent,
  isTerminalRunEvent,
  isTerminalRunStatus,
} from './model/run-events';
import type { LiveConnectionStatus } from './model/live-updates';

type ConnectionStatus = LiveConnectionStatus;

type RunEventState = Readonly<{
  scopeKey: string;
  timeline: readonly WorkflowRunEvent[];
  truncatedCount: number;
  connectionStatus: ConnectionStatus;
  recoveryMessage?: string;
}>;

function initialRunEventState(scopeKey: string): RunEventState {
  return {
    scopeKey,
    timeline: [],
    truncatedCount: 0,
    connectionStatus: 'connecting',
  };
}

export function useRunEvents(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  const queryClient = useQueryClient();
  // Reconnecting after a pause starts a fresh stream that backfills from the
  // first event, so it also starts a fresh timeline.
  const [generation, setGeneration] = useState(0);
  const scopeKey = `${userId}\u0000${workspaceId}\u0000${runId}\u0000${String(generation)}`;
  const [state, setState] = useState<RunEventState>(() =>
    initialRunEventState(scopeKey),
  );
  const lifecycle = useRef(0);

  useEffect(() => {
    const lifecycleId = lifecycle.current + 1;
    lifecycle.current = lifecycleId;
    const controller = new AbortController();
    const query = workflowRunQueryOptions(
      apiClient,
      userId,
      workspaceId,
      runId,
    );
    let cursor = 0;
    let failures = 0;
    let snapshotRetryNotBefore = 0;
    let refreshTimer: number | undefined;
    let activeStream:
      Awaited<ReturnType<typeof openWorkflowRunEvents>> | undefined;
    const isCurrent = () =>
      lifecycle.current === lifecycleId && !controller.signal.aborted;
    const updateCurrent = (
      update: (current: RunEventState) => RunEventState,
    ) => {
      if (!isCurrent()) return;
      setState((current) => {
        if (!isCurrent()) return current;
        return update(
          current.scopeKey === scopeKey
            ? current
            : initialRunEventState(scopeKey),
        );
      });
    };
    const setConnectionStatus = (connectionStatus: ConnectionStatus) => {
      updateCurrent((current) => ({
        scopeKey: current.scopeKey,
        timeline: current.timeline,
        truncatedCount: current.truncatedCount,
        connectionStatus,
      }));
    };
    const setRecovery = (
      connectionStatus: ConnectionStatus,
      recoveryMessage: string,
    ) => {
      updateCurrent((current) => ({
        ...current,
        connectionStatus,
        recoveryMessage,
      }));
    };

    const scheduleSnapshotRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: query.queryKey });
      }, 250);
    };

    const refreshSnapshot = async () => {
      const snapshot = await queryClient.query(query);
      return isTerminalRunStatus(snapshot.run.status);
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        let stream:
          Awaited<ReturnType<typeof openWorkflowRunEvents>> | undefined;
        try {
          setConnectionStatus(
            failures === 0
              ? 'connecting'
              : failures >= 3
                ? 'degraded'
                : 'reconnecting',
          );
          stream = await openWorkflowRunEvents(
            apiClient,
            workspaceId,
            runId,
            cursor,
            controller.signal,
          );
          activeStream = stream;
          if (!isCurrent()) return;
          setConnectionStatus('live');
          for await (const message of decodeSseMessages(stream.body)) {
            if (!isCurrent()) return;
            const event = decodeRunEvent(message);
            if (classifyRunEvent(cursor, event) === 'duplicate') continue;
            cursor = event.sequence;
            updateCurrent((current) => {
              const appended = appendRunEvent(current.timeline, event);
              return {
                ...current,
                timeline: appended.timeline,
                truncatedCount: current.truncatedCount + appended.truncated,
              };
            });
            scheduleSnapshotRefresh();
            if (isTerminalRunEvent(event)) {
              await refreshSnapshot();
              setConnectionStatus('stopped');
              return;
            }
          }
          throw new TransientStreamDisconnect(
            'The run event stream closed before the run completed.',
          );
        } catch (error) {
          if (!isCurrent()) return;
          const recovery = classifyStreamFailure(error, failures + 1);
          if (recovery.kind === 'stop') {
            setRecovery(recovery.status, recovery.message);
            return;
          }
          failures += 1;
          setRecovery(recovery.status, recovery.message);
          if (failures >= 3 && Date.now() >= snapshotRetryNotBefore) {
            try {
              if (await refreshSnapshot()) {
                setConnectionStatus('stopped');
                return;
              }
              snapshotRetryNotBefore = 0;
            } catch (snapshotError) {
              const snapshotRecovery = classifyStreamFailure(
                snapshotError,
                failures,
              );
              if (snapshotRecovery.kind === 'stop') {
                setRecovery(snapshotRecovery.status, snapshotRecovery.message);
                return;
              }
              snapshotRetryNotBefore = Date.now() + snapshotRecovery.delayMs;
              setRecovery(snapshotRecovery.status, snapshotRecovery.message);
            }
          }
          const snapshotWait = snapshotRetryNotBefore - Date.now();
          await delay(
            snapshotWait > 0
              ? Math.max(recovery.delayMs, snapshotWait)
              : recovery.delayMs,
            controller.signal,
          );
        } finally {
          stream?.close();
          if (activeStream === stream) activeStream = undefined;
        }
      }
    };

    void run();
    return () => {
      if (lifecycle.current === lifecycleId) lifecycle.current += 1;
      controller.abort();
      activeStream?.close();
      activeStream = undefined;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [apiClient, queryClient, runId, scopeKey, userId, workspaceId]);

  const visible =
    state.scopeKey === scopeKey ? state : initialRunEventState(scopeKey);
  return {
    timeline: visible.timeline,
    truncatedCount: visible.truncatedCount,
    connectionStatus: visible.connectionStatus,
    recoveryMessage: visible.recoveryMessage,
    reconnect: () => {
      setGeneration((current) => current + 1);
    },
  } as const;
}

type StreamRecovery =
  | Readonly<{
      kind: 'stop';
      status: ConnectionStatus;
      message: string;
    }>
  | Readonly<{
      kind: 'retry';
      status: ConnectionStatus;
      message: string;
      delayMs: number;
    }>;

function classifyStreamFailure(
  error: unknown,
  failures: number,
): StreamRecovery {
  if (isApiError(error)) {
    if (error.status === 401)
      return {
        kind: 'stop',
        status: 'authentication-required',
        message:
          'Live updates paused because your session ended. Sign in again to resume them.',
      };
    if (error.status === 403)
      return {
        kind: 'stop',
        status: 'access-denied',
        message:
          'Live updates paused because your role can’t follow this run any more.',
      };
    if (error.status === 404)
      return {
        kind: 'stop',
        status: 'unavailable',
        message: 'Live updates aren’t available for this run.',
      };
    if (error.status === 429)
      return {
        kind: 'retry',
        status: 'rate-limited',
        message:
          'Too many live connections right now. Updates resume on their own shortly.',
        delayMs: Math.min(
          300_000,
          error.retryAfterMs ?? transientDelay(failures),
        ),
      };
    if (error.kind === 'canceled')
      return {
        kind: 'stop',
        status: 'stopped',
        message: 'Live updates were stopped.',
      };
    if (
      error.kind !== 'network' &&
      error.kind !== 'timeout' &&
      (error.status === undefined || error.status < 500)
    )
      return {
        kind: 'stop',
        status: 'failed',
        message:
          'Live updates paused because Pertexo sent an update this page couldn’t read.',
      };
  } else if (
    !(error instanceof TransientStreamDisconnect) &&
    !(error instanceof TypeError) &&
    !(error instanceof DOMException && error.name === 'NetworkError')
  ) {
    return {
      kind: 'stop',
      status: 'failed',
      message: 'Live updates paused because an update couldn’t be read.',
    };
  }
  return {
    kind: 'retry',
    status: failures >= 3 ? 'degraded' : 'reconnecting',
    message:
      failures >= 3
        ? 'Live updates keep dropping. Pertexo still checks the run and keeps reconnecting.'
        : 'Live updates disconnected. Reconnecting…',
    delayMs: transientDelay(failures),
  };
}

class TransientStreamDisconnect extends Error {}

function transientDelay(failures: number): number {
  return (
    Math.min(10_000, 500 * 2 ** Math.min(failures, 4)) +
    Math.floor(Math.random() * 250)
  );
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
