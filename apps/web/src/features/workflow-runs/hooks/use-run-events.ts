import {
  streamWasHealthy,
  classifyStreamFailure,
  TransientStreamDisconnect,
  delay,
} from '../model/live-stream';
import type { WorkflowRunEvent } from '@pertexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { decodeSseMessages } from '@/lib/api/sse';
import { openWorkflowRunEvents } from '../data/workflow-runs.api';
import { workflowRunQueryOptions } from '../data/detail.queries';
import {
  appendRunEvent,
  classifyRunEvent,
  decodeRunEvent,
  isTerminalRunEvent,
  isTerminalRunStatus,
} from '../model/timeline/run-events';
import type { LiveConnectionStatus } from '../model/live-updates';

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
        let openedAt: number | undefined;
        let delivered = false;
        try {
          setConnectionStatus(
            failures === 0
              ? 'connecting'
              : failures >= 3
                ? 'degraded'
                : 'reconnecting',
          );
          stream = await openWorkflowRunEvents({
            apiClient,
            workspaceId,
            runId,
            lastEventId: cursor,
            signal: controller.signal,
          });
          activeStream = stream;
          openedAt = Date.now();
          if (!isCurrent()) return;
          setConnectionStatus('live');
          for await (const message of decodeSseMessages(stream.body)) {
            if (!isCurrent()) return;
            const event = decodeRunEvent(message);
            if (classifyRunEvent(cursor, event) === 'duplicate') continue;
            cursor = event.sequence;
            delivered = true;
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
          if (streamWasHealthy({ delivered, openedAt })) failures = 0;
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
