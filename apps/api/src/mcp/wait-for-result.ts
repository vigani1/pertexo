import { RedisRunEventSubscribeError } from '../workflow-runs/events/redis-subscribe.js';
import type { LiveRunEventSubscription } from '../workflow-runs/events/stream.js';
import type { McpRuntime } from './mcp.service.js';

const MCP_RESULT_WAIT_MAX_MILLIS = 5_000;

type StatusInput = Parameters<McpRuntime['runs']['readMcpToolStatus']>[0];

/** Live notifications only wake the same authorized reader the status tool uses. */
export async function waitForMcpResult(
  { runs, liveSource }: McpRuntime,
  input: StatusInput &
    Readonly<{ disconnected: AbortSignal; waitMillis: number | undefined }>,
) {
  const { disconnected, waitMillis, ...statusInput } = input;
  const pending = { status: 'pending' as const, invocation: input.invocation };
  // A client may only shorten the wait; anything longer uses the maximum.
  const budget =
    waitMillis !== undefined && waitMillis < MCP_RESULT_WAIT_MAX_MILLIS
      ? waitMillis
      : MCP_RESULT_WAIT_MAX_MILLIS;
  if (budget === 0 || disconnected.aborted) return pending;

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, budget);
  const signal = AbortSignal.any([disconnected, deadline.signal]);
  let subscription: LiveRunEventSubscription | undefined;
  try {
    // Subscribe before reading so a completion racing the first read wakes us.
    subscription = await liveSource.subscribe({
      workspaceId: input.workspaceId,
      runId: input.runId,
      signal,
    });
    const read = () => runs.readMcpToolStatus({ ...statusInput, signal });
    const initial = await read();
    signal.throwIfAborted();
    if (initial.status !== 'pending') return initial;

    for await (const _notification of subscription) {
      signal.throwIfAborted();
      const status = await read();
      signal.throwIfAborted();
      if (status.status !== 'pending') return status;
    }
    return pending;
  } catch (error) {
    if (signal.aborted || error instanceof RedisRunEventSubscribeError)
      return pending;
    throw error;
  } finally {
    clearTimeout(timer);
    await subscription?.close();
  }
}
