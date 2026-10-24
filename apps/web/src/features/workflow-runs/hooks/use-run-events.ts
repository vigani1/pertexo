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

    void followRunEvents({
      signal: controller.signal,
      isCurrent,
      updateCurrent,
      setConnectionStatus,
      setRecovery,
      scheduleSnapshotRefresh,
      refreshSnapshot,
      open: async (cursor) => {
        const stream = await openWorkflowRunEvents({
          apiClient,
          workspaceId,
          runId,
          lastEventId: cursor,
          signal: controller.signal,
        });
        activeStream = stream;
        return stream;
      },
      close: (stream) => {
        stream?.close();
        if (activeStream === stream) activeStream = undefined;
      },
    });
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

type RunEventStream = Awaited<ReturnType<typeof openWorkflowRunEvents>>;
type RunEventSession = Readonly<{
  signal: AbortSignal;
  isCurrent: () => boolean;
  open: (cursor: number) => Promise<RunEventStream>;
  close: (stream: RunEventStream | undefined) => void;
  updateCurrent: (update: (current: RunEventState) => RunEventState) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setRecovery: (status: ConnectionStatus, message: string) => void;
  scheduleSnapshotRefresh: () => void;
  refreshSnapshot: () => Promise<boolean>;
}>;

async function followRunEvents(options: RunEventSession) {
  let cursor = 0,
    failures = 0,
    snapshotRetryNotBefore = 0;

  while (!options.signal.aborted) {
    let stream: Awaited<ReturnType<typeof openWorkflowRunEvents>> | undefined;
    let openedAt: number | undefined;
    let delivered = false;
    try {
      options.setConnectionStatus(reconnectStatus(failures));
      stream = await options.open(cursor);
      openedAt = Date.now();
      if (!options.isCurrent()) return;
      options.setConnectionStatus('live');
      for await (const message of decodeSseMessages(stream.body)) {
        if (!options.isCurrent()) return;
        const event = decodeRunEvent(message);
        if (classifyRunEvent(cursor, event) === 'duplicate') continue;
        cursor = event.sequence;
        delivered = true;
        options.updateCurrent((current) => {
          const appended = appendRunEvent(current.timeline, event);
          return {
            ...current,
            timeline: appended.timeline,
            truncatedCount: current.truncatedCount + appended.truncated,
          };
        });
        options.scheduleSnapshotRefresh();
        if (isTerminalRunEvent(event)) {
          await options.refreshSnapshot();
          options.setConnectionStatus('stopped');
          return;
        }
      }
      throw new TransientStreamDisconnect(
        'The run event stream closed before the run completed.',
      );
    } catch (error) {
      if (!options.isCurrent()) return;
      if (streamWasHealthy({ delivered, openedAt })) failures = 0;
      const recovery = classifyStreamFailure(error, failures + 1);
      if (recovery.kind === 'stop') {
        options.setRecovery(recovery.status, recovery.message);
        return;
      }
      failures += 1;
      options.setRecovery(recovery.status, recovery.message);
      if (failures >= 3 && Date.now() >= snapshotRetryNotBefore) {
        const nextSnapshotRetry = await refreshAfterFailures(options, failures);
        if (nextSnapshotRetry === undefined) return;
        snapshotRetryNotBefore = nextSnapshotRetry;
      }
      const snapshotWait = snapshotRetryNotBefore - Date.now();
      await delay(
        snapshotWait > 0
          ? Math.max(recovery.delayMs, snapshotWait)
          : recovery.delayMs,
        options.signal,
      );
    } finally {
      options.close(stream);
    }
  }
}

function reconnectStatus(failures: number): ConnectionStatus {
  if (failures === 0) return 'connecting';
  if (failures >= 3) return 'degraded';
  return 'reconnecting';
}

async function refreshAfterFailures(
  options: RunEventSession,
  failures: number,
): Promise<number | undefined> {
  try {
    if (await options.refreshSnapshot()) {
      options.setConnectionStatus('stopped');
      return undefined;
    }
    return 0;
  } catch (error) {
    const recovery = classifyStreamFailure(error, failures);
    if (recovery.kind === 'stop') {
      options.setRecovery(recovery.status, recovery.message);
      return undefined;
    }
    const nextRetry = Date.now() + recovery.delayMs;
    options.setRecovery(recovery.status, recovery.message);
    return nextRetry;
  }
}
