import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
  type WorkspaceStatus,
} from '../../authorization/index.js';
import type { WorkflowRunApplicationInput } from '../ports.js';
import { RunEventStreamUnauthorizedError } from './run-events.errors.js';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/policy';

type SseAuthorizationLifetimeInput = Pick<
  WorkflowRunApplicationInput,
  'actor' | 'routeWorkspaceId'
> &
  Readonly<{
    /** What the stream shows; run events by default. */
    capability?: AuthorizationCapability;
    now?: () => number;
    allowedWorkspaceStatuses?: readonly WorkspaceStatus[];
    reauthorizeResource?: (signal: AbortSignal) => Promise<void>;
    sessionExpiresAt: Date;
    reauthorizeSession: (signal: AbortSignal) => Promise<
      Readonly<{
        userId: string;
        sessionId: string;
        expiresAt: Date;
      }>
    >;
    abortStream(reason?: unknown): void;
    signal: AbortSignal;
  }>;

export type StreamAuthorizationLifetime = Readonly<{
  authorizationLost: AbortSignal;
  reauthorize(): Promise<void>;
  stop(): Promise<void>;
}>;

/** Final portion of the verified lifetime reserved for completing fresh I/O. */
const AUTHORIZATION_LOOKUP_BUDGET_MS = 1_000;

export function createStreamAuthorizationLifetime(
  input: SseAuthorizationLifetimeInput,
  authorization: WorkspaceAuthorizationSource,
  intervalMs: number,
  lifetimeController: AbortController,
): StreamAuthorizationLifetime {
  const now = input.now ?? Date.now;
  const stopController = new AbortController();
  const watchdogSignal = AbortSignal.any([input.signal, stopController.signal]);
  let authorizationDeadline = Math.min(
    now() + intervalMs,
    input.sessionExpiresAt.getTime(),
  );
  let nextIdleRefreshAt =
    authorizationDeadline - AUTHORIZATION_LOOKUP_BUDGET_MS;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let pendingAuthorization: Promise<void> | undefined;
  let revoked = false;

  const clearDeadlineTimer = (): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  const revoke = (error: unknown): void => {
    if (revoked) return;
    revoked = true;
    clearDeadlineTimer();
    lifetimeController.abort(error);
    input.abortStream(error);
  };
  const armAuthorizationDeadline = (
    sessionExpiresAt: Date,
    { afterRefresh }: Readonly<{ afterRefresh: boolean }>,
  ): void => {
    clearDeadlineTimer();
    const previousDeadline = authorizationDeadline;
    const currentTime = now();
    const nextDeadline = Math.min(
      currentTime + intervalMs,
      sessionExpiresAt.getTime(),
    );
    authorizationDeadline = nextDeadline;
    nextIdleRefreshAt =
      afterRefresh && nextDeadline <= previousDeadline
        ? nextDeadline
        : nextDeadline - AUTHORIZATION_LOOKUP_BUDGET_MS;
    deadlineTimer = setTimeout(
      () => {
        revoke(new Error('SSE authorization lifetime expired'));
      },
      Math.max(0, authorizationDeadline - currentTime),
    );
  };
  const performAuthorization = async (signal: AbortSignal): Promise<void> => {
    const session = await input.reauthorizeSession(signal);
    signal.throwIfAborted();
    const invalidRefreshedSession =
      input.actor.kind !== 'user' ||
      session.userId !== input.actor.actorId ||
      session.sessionId !== input.actor.sessionId ||
      !Number.isFinite(session.expiresAt.getTime()) ||
      session.expiresAt.getTime() <= now();
    if (invalidRefreshedSession) {
      throw new RunEventStreamUnauthorizedError(
        'SSE session is no longer authorized',
      );
    }
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: input.capability ?? 'run:read',
      access: authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses:
        input.allowedWorkspaceStatuses ?? UNPURGED_WORKSPACE_STATUSES,
      signal,
    });
    signal.throwIfAborted();
    await input.reauthorizeResource?.(signal);
    signal.throwIfAborted();
    armAuthorizationDeadline(session.expiresAt, { afterRefresh: true });
  };
  const reauthorize = (): Promise<void> => {
    if (pendingAuthorization !== undefined) return pendingAuthorization;
    const remainingMs = Math.max(1, authorizationDeadline - now());
    const operationSignal = AbortSignal.any([
      watchdogSignal,
      AbortSignal.timeout(remainingMs),
    ]);
    operationSignal.throwIfAborted();
    const current = raceAgainstAbort(
      performAuthorization(operationSignal),
      operationSignal,
    ).then(
      () => {
        if (pendingAuthorization === current) pendingAuthorization = undefined;
      },
      (error: unknown) => {
        if (pendingAuthorization === current) pendingAuthorization = undefined;
        throw error;
      },
    );
    pendingAuthorization = current;
    return current;
  };
  armAuthorizationDeadline(input.sessionExpiresAt, { afterRefresh: false });
  const streamStopped = (): boolean => watchdogSignal.aborted;
  const watchdog = (async (): Promise<void> => {
    while (!watchdogSignal.aborted) {
      const wait = waitUntilAuthorizationDeadline(
        nextIdleRefreshAt,
        watchdogSignal,
        now,
      );
      const outcome = await wait.promise;
      wait.cancel();
      if (outcome.kind === 'aborted') return;
      try {
        await reauthorize();
      } catch (error: unknown) {
        if (streamStopped()) return;
        revoke(error);
        return;
      }
    }
  })();

  return {
    authorizationLost: lifetimeController.signal,
    reauthorize: async () => {
      try {
        await reauthorize();
      } catch (error: unknown) {
        if (watchdogSignal.aborted) throw error;
        revoke(error);
        throw error;
      }
    },
    stop: async () => {
      clearDeadlineTimer();
      stopController.abort(new DOMException('SSE stream closed', 'AbortError'));
      await watchdog;
    },
  };
}

export async function nextFrameOrAuthorizationLoss<T>(
  iterator: AsyncIterator<T>,
  authorizationLost: AbortSignal,
): Promise<
  | Readonly<{ kind: 'frame'; result: IteratorResult<T> }>
  | Readonly<{ kind: 'authorization_lost'; error: unknown }>
> {
  if (authorizationLost.aborted) {
    return {
      kind: 'authorization_lost',
      error: authorizationLost.reason,
    };
  }
  let resolveLoss:
    | ((
        value: Readonly<{ kind: 'authorization_lost'; error: unknown }>,
      ) => void)
    | undefined;
  const lost = new Promise<
    Readonly<{ kind: 'authorization_lost'; error: unknown }>
  >((resolve) => {
    resolveLoss = resolve;
  });
  const onAuthorizationLost = (): void => {
    resolveLoss?.({
      kind: 'authorization_lost',
      error: authorizationLost.reason,
    });
  };
  // Subscribe before checking again so an intervening abort is observed.
  authorizationLost.addEventListener('abort', onAuthorizationLost, {
    once: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Subscription can change the signal; TypeScript keeps the earlier narrowing.
  if (authorizationLost.aborted) onAuthorizationLost();
  try {
    const outcome = await Promise.race([
      iterator.next().then((result) => ({ kind: 'frame' as const, result })),
      lost,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The awaited producer can abort authorization.
    return authorizationLost.aborted
      ? {
          kind: 'authorization_lost',
          error: authorizationLost.reason,
        }
      : outcome;
  } finally {
    authorizationLost.removeEventListener('abort', onAuthorizationLost);
  }
}

async function raceAgainstAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(
      signal.reason ?? new DOMException('Operation aborted', 'AbortError'),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function waitUntilAuthorizationDeadline(
  deadline: number,
  signal: AbortSignal,
  now: () => number,
): Readonly<{
  promise: Promise<
    Readonly<{ kind: 'aborted' }> | Readonly<{ kind: 'reauthorize' }>
  >;
  cancel(): void;
}> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveWait: (
    value: Readonly<{ kind: 'aborted' }> | Readonly<{ kind: 'reauthorize' }>,
  ) => void = () => undefined;
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    resolveWait({ kind: 'aborted' });
  };
  const promise = new Promise<
    Readonly<{ kind: 'aborted' }> | Readonly<{ kind: 'reauthorize' }>
  >((resolve) => {
    resolveWait = resolve;
    if (signal.aborted) {
      settled = true;
      resolve({ kind: 'aborted' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Recheck after subscribing, despite TypeScript's earlier narrowing.
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'reauthorize' });
      },
      Math.max(0, deadline - now()),
    );
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
    },
  };
}
