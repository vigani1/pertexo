import type { InboxWriteActivity } from './inbox-write-transaction.js';

type SettlingInboxWriteActivity = InboxWriteActivity &
  Readonly<{ settle(): Promise<void> }>;

// One source writer across BOTH capture/projection and all store instances.
let admitted: object | undefined;
let disposalUnconfirmed = false;

export function inboxWritesAvailable(): boolean {
  return !disposalUnconfirmed;
}

export function admitInboxWrite(): SettlingInboxWriteActivity | undefined {
  if (disposalUnconfirmed) throw new Error('Inbox writer is unavailable');
  if (admitted !== undefined) return undefined;
  const identity = {};
  admitted = identity;
  const pending = new Set<Promise<unknown>>();
  return {
    track: <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
    failDisposal: () => {
      disposalUnconfirmed = true;
    },
    settle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
      if (admitted === identity) admitted = undefined;
    },
  };
}

/** Private per-store lifetime; command results and deadlines stay with callers. */
export function createInboxWriteLifetime(closePool: () => Promise<void>) {
  const operations = new Set<Promise<void>>();
  let closed = false;
  let cancel: AbortController | undefined;
  let closing: Promise<void> | undefined;
  const idle = async (): Promise<void> => {
    while (operations.size > 0) await Promise.all([...operations]);
  };
  return Object.freeze({
    isClosed: (): boolean => closed,
    observe: <T>(
      controller: AbortController,
      activity: SettlingInboxWriteActivity,
      start: () => Promise<T>,
    ) => {
      cancel = controller;
      const task = start();
      const settled = task
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => activity.settle())
        .then(() => {
          if (cancel === controller) cancel = undefined;
        });
      operations.add(settled);
      void settled.then(() => operations.delete(settled));
      return { task, settled };
    },
    whenIdle: idle,
    close: (): Promise<void> => {
      closed = true;
      cancel?.abort();
      closing ??= Promise.resolve().then(async () => {
        const pending = idle();
        try {
          await withinInboxWriteSettlement(pending);
        } catch (error: unknown) {
          void pending.then(() => closePool()).catch(() => undefined);
          throw error;
        }
        await closePool();
      });
      return closing;
    },
  });
}

export async function withinInboxWriteSettlement(
  promise: Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          disposalUnconfirmed = true;
          reject(new Error('Inbox writer disposal is unconfirmed'));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
