import { WebhookIntakeBusyError } from '../errors.js';

interface Line {
  /** Turns running now. A finishing turn hands its place to the next in line. */
  running: number;
  /** Insertion order is arrival order, and a waiter that gives up leaves in place. */
  readonly waiting: Set<() => void>;
}

/**
 * Accepting a run holds the workspace's admission counter row for about a dozen
 * round trips, so one workspace's acceptances finish one at a time however many
 * start. Any beyond a few would only sit on pooled connections, blocked on that
 * row, while every other request in this process, for any workspace, queues
 * behind them. They wait here instead, holding no connection.
 */
export function createWorkspaceTurns({
  atOnce,
  maxWaitMillis,
}: Readonly<{ atOnce: number; maxWaitMillis: number }>) {
  const lines = new Map<string, Line>();

  function waitInLine(line: Line, signal: AbortSignal | undefined) {
    return new Promise<void>((resolve, reject) => {
      const leave = (reason: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        line.waiting.delete(begin);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caller's own abort reason, unchanged
        reject(reason);
      };
      const onAbort = () => {
        leave(signal?.reason);
      };
      const begin = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        leave(new WebhookIntakeBusyError());
      }, maxWaitMillis);
      line.waiting.add(begin);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function finishTurn(workspaceId: string, line: Line) {
    const [next] = line.waiting;
    if (next !== undefined) {
      line.waiting.delete(next);
      next();
      return;
    }
    line.running -= 1;
    if (line.running === 0) lines.delete(workspaceId);
  }

  return {
    /**
     * Runs the work in the workspace's next turn, in arrival order. A wait that
     * runs out, or a signal that fires first, means the work never ran.
     */
    async take<T>(
      workspaceId: string,
      signal: AbortSignal | undefined,
      work: () => Promise<T>,
    ): Promise<T> {
      signal?.throwIfAborted();
      const line = lines.get(workspaceId) ?? {
        running: 0,
        waiting: new Set(),
      };
      lines.set(workspaceId, line);
      if (line.running < atOnce) line.running += 1;
      else await waitInLine(line, signal);
      try {
        return await work();
      } finally {
        finishTurn(workspaceId, line);
      }
    },
  };
}

export type WorkspaceTurns = ReturnType<typeof createWorkspaceTurns>;
